import axios, { type AxiosRequestConfig } from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface SharePointConfig {
  tenantId?: string
  clientId?: string
  clientSecret?: string
  graphBaseUrl?: string
  scope?: string
  defaultSiteId?: string
  defaultDriveId?: string
}

interface SharePointCredentials {
  bearerToken?: string
  username?: string
  password?: string
  clientSecret?: string
}

export class SharePointAdapter implements ConnectorAdapter {
  private tokenCache: { token: string; expiresAt: number; cacheKey: string } | null = null

  constructor(private config: SharePointConfig, private creds: SharePointCredentials) {}

  async testConnection() {
    try {
      const hasStoredCredential = this.creds.bearerToken || (this.creds.username && this.creds.password)
      if (!hasStoredCredential) {
        return {
          ok: false,
          error: 'No stored SharePoint token or username/password. Runtime credentials are supported during workflow invoke.',
        }
      }
      await this.graphRequest('GET', this.config.defaultSiteId ? `/sites/${this.config.defaultSiteId}` : '/me', {})
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.response?.data?.error?.message ?? e?.response?.data?.error_description ?? e?.message }
    }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'getSiteByPath': return this.getSiteByPath(params)
      case 'listDrives': return this.listDrives(params)
      case 'listChildren': return this.listChildren(params)
      case 'uploadText': return this.uploadText(params)
      case 'downloadText': return this.downloadText(params)
      case 'createFolder': return this.createFolder(params)
      case 'deleteItem': return this.deleteItem(params)
      default: throw new Error(`Unknown SharePoint operation: ${operation}`)
    }
  }

  private get graphBaseUrl() {
    return this.config.graphBaseUrl ?? 'https://graph.microsoft.com/v1.0'
  }

  private getScope() {
    return this.config.scope ?? 'https://graph.microsoft.com/Files.ReadWrite.All https://graph.microsoft.com/Sites.ReadWrite.All offline_access'
  }

  private stringParam(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  private requireString(params: Record<string, unknown>, key: string): string {
    const value = this.stringParam(params, key)
    if (!value) throw new Error(`SharePoint ${key} is required`)
    return value
  }

  private encodePath(path?: string): string {
    return String(path ?? '')
      .split('/')
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
      .join('/')
  }

  private driveRootPath(siteId: string, driveId: string, itemPath?: string): string {
    const encodedPath = this.encodePath(itemPath)
    if (!encodedPath) return `/sites/${siteId}/drives/${driveId}/root`
    return `/sites/${siteId}/drives/${driveId}/root:/${encodedPath}:`
  }

  private resolveSiteId(params: Record<string, unknown>) {
    const siteId = this.stringParam(params, 'siteId') ?? this.config.defaultSiteId
    if (!siteId) throw new Error('SharePoint siteId is required. Set defaultSiteId on the connector or pass siteId at runtime.')
    return siteId
  }

  private resolveDriveId(params: Record<string, unknown>) {
    const driveId = this.stringParam(params, 'driveId') ?? this.config.defaultDriveId
    if (!driveId) throw new Error('SharePoint driveId is required. Set defaultDriveId on the connector or pass driveId at runtime.')
    return driveId
  }

  private async getToken(params: Record<string, unknown>): Promise<string> {
    const runtimeBearer = this.stringParam(params, 'bearerToken')
    if (runtimeBearer) return runtimeBearer
    if (this.creds.bearerToken) return this.creds.bearerToken

    const tenantId = this.stringParam(params, 'tenantId') ?? this.config.tenantId
    const clientId = this.stringParam(params, 'clientId') ?? this.config.clientId
    const clientSecret = this.stringParam(params, 'clientSecret') ?? this.creds.clientSecret ?? this.config.clientSecret
    const username = this.stringParam(params, 'username') ?? this.creds.username
    const password = this.stringParam(params, 'password') ?? this.creds.password

    if (!tenantId || !clientId || !username || !password) {
      throw new Error('SharePoint requires bearerToken, or tenantId/clientId plus username/password. Username/password can be passed at workflow runtime.')
    }

    const cacheKey = `${tenantId}:${clientId}:${username}:${clientSecret ? 'confidential' : 'public'}`
    if (this.tokenCache && this.tokenCache.cacheKey === cacheKey && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token
    }

    const form = new URLSearchParams()
    form.set('client_id', clientId)
    form.set('grant_type', 'password')
    form.set('username', username)
    form.set('password', password)
    form.set('scope', this.getScope())
    if (clientSecret) form.set('client_secret', clientSecret)

    const res = await axios.post(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    this.tokenCache = {
      token: res.data.access_token,
      expiresAt: Date.now() + Number(res.data.expires_in ?? 3600) * 1000,
      cacheKey,
    }
    return this.tokenCache.token
  }

  private async graphRequest<T>(
    method: AxiosRequestConfig['method'],
    path: string,
    params: Record<string, unknown>,
    data?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    const token = await this.getToken(params)
    const res = await axios.request<T>({
      method,
      baseURL: this.graphBaseUrl,
      url: path,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      responseType: method === 'GET' && path.endsWith('/content') ? 'text' : 'json',
    })
    return res.data
  }

  private getSiteByPath(params: Record<string, unknown>) {
    const hostname = this.requireString(params, 'hostname')
    const sitePath = this.requireString(params, 'sitePath').replace(/^\/+/, '')
    return this.graphRequest('GET', `/sites/${encodeURIComponent(hostname)}:/${this.encodePath(sitePath)}`, params)
  }

  private listDrives(params: Record<string, unknown>) {
    const siteId = this.resolveSiteId(params)
    return this.graphRequest('GET', `/sites/${siteId}/drives`, params)
  }

  private listChildren(params: Record<string, unknown>) {
    const siteId = this.resolveSiteId(params)
    const driveId = this.resolveDriveId(params)
    const folderPath = this.stringParam(params, 'folderPath')
    const root = this.driveRootPath(siteId, driveId, folderPath)
    return this.graphRequest('GET', `${root}/children`, params)
  }

  private uploadText(params: Record<string, unknown>) {
    const siteId = this.resolveSiteId(params)
    const driveId = this.resolveDriveId(params)
    const path = this.requireString(params, 'path')
    const content = String(params.content ?? '')
    const contentType = this.stringParam(params, 'contentType') ?? 'text/plain; charset=utf-8'
    return this.graphRequest('PUT', `${this.driveRootPath(siteId, driveId, path)}/content`, params, content, contentType)
  }

  private downloadText(params: Record<string, unknown>) {
    const siteId = this.resolveSiteId(params)
    const driveId = this.resolveDriveId(params)
    const path = this.requireString(params, 'path')
    return this.graphRequest('GET', `${this.driveRootPath(siteId, driveId, path)}/content`, params, undefined, '')
  }

  private createFolder(params: Record<string, unknown>) {
    const siteId = this.resolveSiteId(params)
    const driveId = this.resolveDriveId(params)
    const name = this.requireString(params, 'name')
    const parentPath = this.stringParam(params, 'parentPath')
    const root = this.driveRootPath(siteId, driveId, parentPath)
    const conflictBehavior = this.stringParam(params, 'conflictBehavior') ?? 'rename'
    return this.graphRequest('POST', `${root}/children`, params, {
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': conflictBehavior,
    })
  }

  private deleteItem(params: Record<string, unknown>) {
    const siteId = this.resolveSiteId(params)
    const driveId = this.resolveDriveId(params)
    const itemId = this.requireString(params, 'itemId')
    return this.graphRequest('DELETE', `/sites/${siteId}/drives/${driveId}/items/${itemId}`, params)
  }

  listOperations(): OperationDef[] {
    const authParams = [
      { key: 'bearerToken', label: 'Runtime Bearer Token', type: 'string' as const, description: 'Optional runtime Graph access token.' },
      { key: 'username', label: 'Runtime Username', type: 'string' as const, description: 'Optional runtime Microsoft user ID.' },
      { key: 'password', label: 'Runtime Password', type: 'string' as const, description: 'Optional runtime Microsoft password.' },
    ]
    const driveParams = [
      { key: 'siteId', label: 'Site ID override', type: 'string' as const },
      { key: 'driveId', label: 'Drive ID override', type: 'string' as const },
      ...authParams,
    ]

    return [
      {
        id: 'getSiteByPath',
        label: 'Get Site By Path',
        params: [
          { key: 'hostname', label: 'SharePoint Hostname', type: 'string', required: true, description: 'Example: contoso.sharepoint.com' },
          { key: 'sitePath', label: 'Site Path', type: 'string', required: true, description: 'Example: sites/Engineering' },
          ...authParams,
        ],
      },
      { id: 'listDrives', label: 'List Document Libraries', params: [{ key: 'siteId', label: 'Site ID override', type: 'string' }, ...authParams] },
      { id: 'listChildren', label: 'List Folder Children', params: [{ key: 'folderPath', label: 'Folder Path', type: 'string' }, ...driveParams] },
      { id: 'uploadText', label: 'Upload Text File', params: [{ key: 'path', label: 'File Path', type: 'string', required: true }, { key: 'content', label: 'Content', type: 'text', required: true }, { key: 'contentType', label: 'Content-Type', type: 'string' }, ...driveParams] },
      { id: 'downloadText', label: 'Download Text File', params: [{ key: 'path', label: 'File Path', type: 'string', required: true }, ...driveParams] },
      { id: 'createFolder', label: 'Create Folder', params: [{ key: 'name', label: 'Folder Name', type: 'string', required: true }, { key: 'parentPath', label: 'Parent Folder Path', type: 'string' }, { key: 'conflictBehavior', label: 'Conflict Behavior', type: 'string', description: 'rename, replace, or fail' }, ...driveParams] },
      { id: 'deleteItem', label: 'Delete Item', params: [{ key: 'itemId', label: 'Drive Item ID', type: 'string', required: true }, ...driveParams] },
    ]
  }
}
