import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";

export type StoredLogPointer = {
  uri: string;
  offset: number;
  bytes: number;
};

export type StoredLogInput = {
  ts: string;
  service: string;
  level: string;
  message: string;
  [key: string]: unknown;
};

export type LogStorageHealth = {
  backend: "filesystem" | "s3";
  configured: boolean;
  path?: string;
  endpoint?: string;
  bucket?: string;
};

export interface LogStorage {
  readonly backend: "filesystem" | "s3";
  writeBatch(records: StoredLogInput[]): Promise<StoredLogPointer[]>;
  health(): LogStorageHealth;
}

export function sanitizeLogSegment(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "unknown";
}

function dayParts(ts: string): { year: string; month: string; day: string } {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return {
      year: String(now.getUTCFullYear()),
      month: String(now.getUTCMonth() + 1).padStart(2, "0"),
      day: String(now.getUTCDate()).padStart(2, "0"),
    };
  }
  return {
    year: String(d.getUTCFullYear()),
    month: String(d.getUTCMonth() + 1).padStart(2, "0"),
    day: String(d.getUTCDate()).padStart(2, "0"),
  };
}

export function buildLogObjectKey(record: Pick<StoredLogInput, "ts" | "service">, suffix = "logs.ndjson"): string {
  const { year, month, day } = dayParts(record.ts);
  return `${year}/${month}/${day}/${sanitizeLogSegment(record.service)}/${suffix}`;
}

function lineFor(record: StoredLogInput): string {
  return `${JSON.stringify(record)}\n`;
}

class FilesystemLogStorage implements LogStorage {
  readonly backend = "filesystem" as const;

  constructor(private readonly rootPath: string) {}

  health(): LogStorageHealth {
    return { backend: this.backend, configured: true, path: this.rootPath };
  }

  async writeBatch(records: StoredLogInput[]): Promise<StoredLogPointer[]> {
    const pointers: StoredLogPointer[] = new Array(records.length);
    const groups = new Map<string, Array<{ index: number; line: string; bytes: number }>>();

    records.forEach((record, index) => {
      const key = buildLogObjectKey(record);
      const group = groups.get(key) ?? [];
      const line = lineFor(record);
      group.push({ index, line, bytes: Buffer.byteLength(line, "utf8") });
      groups.set(key, group);
    });

    for (const [key, entries] of groups) {
      const filePath = path.join(this.rootPath, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let offset = 0;
      try {
        const stat = await fs.stat(filePath);
        offset = stat.size;
      } catch {
        offset = 0;
      }

      const content = entries.map((entry) => entry.line).join("");
      await fs.appendFile(filePath, content, "utf8");

      let cursor = offset;
      for (const entry of entries) {
        pointers[entry.index] = {
          uri: `file://${filePath}`,
          offset: cursor,
          bytes: entry.bytes,
        };
        cursor += entry.bytes;
      }
    }

    return pointers;
  }
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hashHex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function amzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodeS3Path(pathValue: string): string {
  return pathValue.split("/").map(encodeURIComponent).join("/");
}

class S3LogStorage implements LogStorage {
  readonly backend = "s3" as const;

  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    private readonly region: string,
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly prefix: string,
  ) {}

  health(): LogStorageHealth {
    return {
      backend: this.backend,
      configured: Boolean(this.endpoint && this.bucket && this.accessKey && this.secretKey),
      endpoint: this.endpoint,
      bucket: this.bucket,
    };
  }

  async writeBatch(records: StoredLogInput[]): Promise<StoredLogPointer[]> {
    const pointers: StoredLogPointer[] = new Array(records.length);
    const groups = new Map<string, Array<{ index: number; line: string; bytes: number }>>();
    const batchId = randomUUID();

    records.forEach((record, index) => {
      const key = buildLogObjectKey(record, `${batchId}.ndjson`);
      const fullKey = this.prefix ? `${this.prefix.replace(/\/+$/g, "")}/${key}` : key;
      const group = groups.get(fullKey) ?? [];
      const line = lineFor(record);
      group.push({ index, line, bytes: Buffer.byteLength(line, "utf8") });
      groups.set(fullKey, group);
    });

    for (const [key, entries] of groups) {
      const body = entries.map((entry) => entry.line).join("");
      await this.putObject(key, body);
      let offset = 0;
      for (const entry of entries) {
        pointers[entry.index] = {
          uri: `s3://${this.bucket}/${key}`,
          offset,
          bytes: entry.bytes,
        };
        offset += entry.bytes;
      }
    }

    return pointers;
  }

  private async putObject(key: string, body: string): Promise<void> {
    if (!this.endpoint || !this.bucket || !this.accessKey || !this.secretKey) {
      throw Object.assign(new Error("S3 log storage is selected but LOG_S3_ENDPOINT, LOG_S3_BUCKET, LOG_S3_ACCESS_KEY, and LOG_S3_SECRET_KEY are required"), { status: 503 });
    }

    const endpointUrl = new URL(this.endpoint);
    const objectPath = `/${encodeURIComponent(this.bucket)}/${encodeS3Path(key)}`;
    const targetUrl = new URL(objectPath, endpointUrl);
    const { amzDate, dateStamp } = amzDates();
    const payloadHash = hashHex(body);
    const host = targetUrl.host;
    const contentType = "application/x-ndjson";
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = [
      `content-type:${contentType}`,
      `host:${host}`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${amzDate}`,
      "",
    ].join("\n");
    const canonicalRequest = [
      "PUT",
      targetUrl.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      hashHex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(targetUrl, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw Object.assign(new Error(`S3 log storage PUT failed: ${response.status} ${response.statusText} ${text}`.trim()), { status: 502 });
    }
  }
}

let storage: LogStorage | null = null;

export function getLogStorage(): LogStorage {
  if (storage) return storage;
  const backend = (process.env.LOG_STORAGE_BACKEND ?? "filesystem").trim().toLowerCase();
  if (backend === "s3") {
    storage = new S3LogStorage(
      process.env.LOG_S3_ENDPOINT ?? "",
      process.env.LOG_S3_BUCKET ?? "",
      process.env.LOG_S3_REGION ?? "us-east-1",
      process.env.LOG_S3_ACCESS_KEY ?? "",
      process.env.LOG_S3_SECRET_KEY ?? "",
      process.env.LOG_S3_PREFIX ?? "singularity-logs",
    );
    return storage;
  }
  storage = new FilesystemLogStorage(process.env.LOG_STORAGE_PATH ?? "/tmp/singularity-logs");
  return storage;
}

export function resetLogStorageForTests(): void {
  storage = null;
}
