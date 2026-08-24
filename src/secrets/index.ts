export interface SecretStore {
  readonly name: string
  get(account: string): Promise<string | null>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

export const SERVICE = 'ccprovider'

/** In-memory store used by tests and dry runs. */
export class MemoryStore implements SecretStore {
  readonly name = 'memory'
  private map = new Map<string, string>()
  async get(a: string) { return this.map.get(a) ?? null }
  async set(a: string, s: string) { this.map.set(a, s) }
  async delete(a: string) { this.map.delete(a) }
}

export async function detectStore(platform: string = process.platform, env = process.env): Promise<SecretStore> {
  if (env.CCPROVIDER_SECRET_BACKEND === 'file') {
    const { FileStore } = await import('./file.js')
    return new FileStore()
  }
  if (platform === 'darwin') {
    const { KeychainStore } = await import('./keychain.js')
    return new KeychainStore()
  }
  const { LibsecretStore } = await import('./libsecret.js')
  if (await LibsecretStore.available()) return new LibsecretStore()
  const { FileStore } = await import('./file.js')
  return new FileStore()
}
