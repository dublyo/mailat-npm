// Minimal stand-ins for framework types so `npm run typecheck:examples` runs
// without installing Next.js, Nuxt, Express, Bun or Deno. They only describe
// the few APIs the examples use; real projects get the real types.

// ---- Nuxt / Nitro (h3) auto-imports
interface H3Event {
  readonly path: string
}
declare function defineEventHandler<T>(handler: (event: H3Event) => T | Promise<T>): (event: H3Event) => Promise<T>
declare function readBody<T>(event: H3Event): Promise<T | undefined>
declare function readRawBody(event: H3Event, encoding: false): Promise<Uint8Array | undefined>
declare function readRawBody(event: H3Event, encoding?: 'utf8'): Promise<string | undefined>
declare function getHeader(event: H3Event, name: string): string | undefined
declare function setResponseStatus(event: H3Event, code: number): void
declare function createError(input: { statusCode: number; statusMessage?: string }): Error
declare function useRuntimeConfig(event?: H3Event): {
  mailat: { url: string; apiKey: string; from: string; webhookSecret: string }
}

// ---- Bun
declare const Bun: {
  serve(options: { port?: number; fetch(request: Request): Response | Promise<Response> }): unknown
}

// ---- Deno
declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (request: Request) => Response | Promise<Response>): unknown
}

// ---- Express (only what examples/express.ts uses)
declare module 'express' {
  interface Request {
    body: unknown
    params: Record<string, string>
    get(name: string): string | undefined
  }
  interface Response {
    status(code: number): Response
    json(body: unknown): Response
    send(body: string): Response
    sendStatus(code: number): Response
  }
  type Handler = (req: Request, res: Response, next: () => void) => unknown
  interface App {
    use(handler: Handler): App
    post(path: string, ...handlers: Handler[]): App
    listen(port: number): unknown
  }
  interface Express {
    (): App
    json(): Handler
    raw(options: { type: string }): Handler
  }
  const express: Express
  export default express
}
