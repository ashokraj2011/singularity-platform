import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { config } from '../config'

const secret = new TextEncoder().encode(config.JWT_SECRET)

export interface JWTUser {
  userId: string
  email: string
  displayName: string
}

export async function signToken(payload: JWTUser): Promise<string> {
  return new SignJWT(payload as unknown as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret)
}

export async function verifyToken(token: string): Promise<JWTUser> {
  const { payload } = await jwtVerify(token, secret)
  return payload as unknown as JWTUser
}
