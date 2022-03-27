import * as pako from 'pako'

// TODO(jlfwong): Figure out proper type annotations
const {JSON_parse} : {JSON_parse: (array: Uint8Array) => any} = require('uint8array-json-parser')

export interface ProfileDataSource {
  name(): Promise<string>
  readAsArrayBuffer(): Promise<ArrayBuffer>
  readAsText(): Promise<TextFileContent>
}


export interface TextFileContent {
  split(separator: string): string[]
  asString(): string
  parseAsJSON(): any
}

// V8 has a maximum string size. To support files whose contents exceeds that
// size, we provide an alternate string interface for text backed by a
// Uint8Array instead.
//
// If the buffer is under a certain size, we fall back to using a simple string
// representation.
//
// See: https://github.com/v8/v8/blob/8b663818fc311217c2cdaaab935f020578bfb7a8/src/objects/string.h#L479-L483
//
// TODO(jlfwong): Write tests for this
export class BufferBackedTextFileContent implements TextFileContent {
  private chunks: string[] = []
  private byteArray: Uint8Array

  constructor(buffer: ArrayBuffer) {
    const byteArray = this.byteArray = new Uint8Array(buffer)

    let encoding: string = 'utf-8'
    if (byteArray.length > 2) {
      if (byteArray[0] === 0xff && byteArray[1] === 0xfe) {
        // UTF-16, Little Endian encoding
        encoding = 'utf-16le'
      } else if (byteArray[0] === 0xfe && byteArray[1] === 0xff) {
        // UTF-16, Big Endian encoding
        encoding = 'utf-16be'
      }
    }

    // At time of writing (2021/03/27), the maximum string length in V8 is
    //  32 bit systems: 2^28 - 16 = ~268M chars
    //  64 bit systems: 2^29 - 24 = ~537M chars
    //
    // https://source.chromium.org/chromium/chromium/src/+/main:v8/include/v8-primitive.h;drc=cb88fe94d9044d860cc75c89e1bc270ab4062702;l=125
    //
    // We'll be conservative and feed in 2^27 bytes at a time (~134M chars
    // assuming utf-8 encoding)
    const CHUNK_SIZE = 1 << 27

    if (typeof TextDecoder !== 'undefined') {
      // If TextDecoder is available, we'll try to use it to decode the string.
      const decoder = new TextDecoder(encoding)

      for (let chunkNum = 0; chunkNum < buffer.byteLength / CHUNK_SIZE; chunkNum++) {
        const offset = chunkNum * CHUNK_SIZE
        const view = new Uint8Array(buffer, offset, Math.min(buffer.byteLength - offset, CHUNK_SIZE))
        const chunk = decoder.decode(view, {stream: true})
        this.chunks.push(chunk)
      }
    } else {
      // JavaScript strings are UTF-16 encoded, but we're reading data from disk
      // that we're going to blindly assume it's ASCII encoded. This codepath
      // only exists for older browser support.

      console.warn('This browser does not support TextDecoder. Decoding text as ASCII.')
      this.chunks.push('')
      for (let i = 0; i < byteArray.length; i++) {
        this.chunks[this.chunks.length - 1] += String.fromCharCode(byteArray[i])
        ;(this.chunks[this.chunks.length - 1] as any) | 0 // This forces the string to be flattened

        if (this.chunks[this.chunks.length - 1].length >= CHUNK_SIZE) {
          this.chunks.push('')
        }
      }
    }
  }

  split(separator: string): string[] {
    let parts: string[] = this.chunks[0].split(separator)
    for (let i = 1; i < this.chunks.length; i++) {
      const chunkParts = this.chunks[i].split(separator)
      if (chunkParts.length === 0) continue
      if (parts.length > 0) {
        parts[parts.length - 1] += chunkParts.shift()
      }
      parts = parts.concat(chunkParts)
    }
    return parts
  }

  asString(): string {
    if (this.chunks.length === 1) {
      return this.chunks[0]
    }
    throw new Error(`String exceeds maximum string length. Buffer size is: ${this.byteArray.length} bytes`)
  }

  parseAsJSON(): any {
    if (this.chunks.length === 1) {
      return JSON.parse(this.chunks[0])
    }
    return JSON_parse(new Uint8Array(this.byteArray))
  }
}

class StringBackedTextFileContent implements TextFileContent {
  constructor(private s: string) {}
  split(separator: string): string[] {
    return this.s.split(separator)
  }
  asString(): string {
    return this.s
  }
  parseAsJSON(): any {
    return JSON.parse(this.s)
  }
}

export class TextProfileDataSource implements ProfileDataSource {
  constructor(private fileName: string, private contents: string) {}
  async name() {
    return this.fileName
  }

  async readAsArrayBuffer() {
    return new ArrayBuffer(0)
  }

  async readAsText() {
    return new StringBackedTextFileContent(this.contents)
  }
}

export class MaybeCompressedDataReader implements ProfileDataSource {
  private uncompressedData: Promise<ArrayBuffer>

  constructor(
    private namePromise: Promise<string>,
    maybeCompressedDataPromise: Promise<ArrayBuffer>,
  ) {
    this.uncompressedData = maybeCompressedDataPromise.then(async (fileData: ArrayBuffer) => {
      try {
        const result = pako.inflate(new Uint8Array(fileData)).buffer
        return result
      } catch (e) {
        return fileData
      }
    })
  }

  async name(): Promise<string> {
    return await this.namePromise
  }

  async readAsArrayBuffer(): Promise<ArrayBuffer> {
    return await this.uncompressedData
  }

  async readAsText(): Promise<TextFileContent> {
    const buffer = await this.readAsArrayBuffer()
    return new BufferBackedTextFileContent(buffer)
  }

  static fromFile(file: File): MaybeCompressedDataReader {
    const maybeCompressedDataPromise: Promise<ArrayBuffer> = new Promise(resolve => {
      const reader = new FileReader()
      reader.addEventListener('loadend', () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          throw new Error('Expected reader.result to be an instance of ArrayBuffer')
        }
        resolve(reader.result)
      })
      reader.readAsArrayBuffer(file)
    })

    return new MaybeCompressedDataReader(Promise.resolve(file.name), maybeCompressedDataPromise)
  }

  static fromArrayBuffer(name: string, buffer: ArrayBuffer): MaybeCompressedDataReader {
    return new MaybeCompressedDataReader(Promise.resolve(name), Promise.resolve(buffer))
  }
}
