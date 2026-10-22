import { ProfileError } from './profile.js'

/**
 * Read a key or token from standard input, for `add --key-stdin`.
 *
 * Standard input and never an argument: an argument ends up in the shell history and in the
 * process list. A terminal is refused rather than prompted, because the flag exists for the
 * case where nobody is there to type, and a hidden prompt on it would hang a script.
 */
export async function readSecretFromStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (stream.isTTY) {
    throw new ProfileError('--key-stdin reads the key from a pipe, and standard input is a terminal. Pipe it in, e.g. `pbpaste | ccprovider add … --key-stdin`.')
  }
  stream.setEncoding('utf8')
  let data = ''
  for await (const chunk of stream) data += chunk
  const secret = data.trim()
  if (!secret) throw new ProfileError('--key-stdin was given, but standard input was empty.')
  return secret
}
