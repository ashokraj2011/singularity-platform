/**
 * ELM Studio design tokens for the Work Item IDE. Returns a scoped CSS-variable override object:
 * it re-skins the platform `--color-*` tokens the studios already consume (so the embedded studios
 * inherit the ELM spruce palette for free) AND defines `--ide-*` chrome tokens for the shell.
 * Light + dark. Apply as an inline style on the IDE container.
 */
export type IdeTheme = 'light' | 'dark'

export function ideTokens(theme: IdeTheme): Record<string, string> {
  const dark = theme === 'dark'
  return {
    // Re-skin the studios (they use these var(--color-*) tokens)
    '--color-primary': dark ? '#46c39d' : '#16745b',
    '--color-primary-dark': dark ? '#bff0e0' : '#0c4436',
    '--color-primary-dim': dark ? '#17322a' : '#e2efe9',
    '--color-secondary': dark ? '#5b9fce' : '#37729c',
    '--color-surface': dark ? '#131b17' : '#ffffff',
    '--color-surface-bright': dark ? '#16201b' : '#ffffff',
    '--color-surface-low': dark ? '#101713' : '#f6f9f7',
    '--color-surface-container': dark ? '#141c18' : '#eef3f4',
    '--color-on-surface': dark ? '#e9efeb' : '#101a16',
    '--color-on-surface-variant': dark ? '#b8c5bd' : '#35443d',
    '--color-outline': dark ? '#859a8f' : '#64756c',
    '--color-outline-variant': dark ? '#24302a' : '#dde5e1',
    '--color-success': dark ? '#4bc489' : '#2e9e6b',
    '--color-warning': dark ? '#d7a13f' : '#b7811f',
    '--color-danger': dark ? '#e0685c' : '#c24a3f',
    '--color-error': dark ? '#e0685c' : '#c24a3f',
    // IDE chrome
    '--ide-bg': dark ? '#0e1411' : '#eef2f0',
    '--ide-chrome': dark ? '#121a15' : '#f6f9f7',
    '--ide-activity': dark ? '#0a100c' : '#e8ede9',
    '--ide-editor': dark ? '#0c120f' : '#ffffff',
    '--ide-line': dark ? '#1e2a23' : '#dce4e0',
    '--ide-line-soft': dark ? '#172019' : '#e7ede9',
    '--ide-ink': dark ? '#d9e2dc' : '#101a16',
    '--ide-ink-dim': dark ? '#9fb0a7' : '#3a4a42',
    '--ide-muted': dark ? '#74877d' : '#64756c',
    '--ide-faint': dark ? '#566258' : '#93a199',
    '--ide-accent': dark ? '#46c39d' : '#16745b',
    '--ide-accent-soft': dark ? '#12271f' : '#e2efe9',
    '--ide-accent-ink': dark ? '#06120d' : '#ffffff',
    '--ide-hover': dark ? '#18221c' : '#eaf0ec',
  }
}
