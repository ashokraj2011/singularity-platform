import { PrismaClient } from '@prisma/client'
import { currentTenantDbClient } from './tenant-db-context'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = basePrisma
}

export const prisma = new Proxy(basePrisma, {
  get(target, property, receiver) {
    const tx = currentTenantDbClient()
    const source = tx && property in Object(tx) ? tx : target
    const value = Reflect.get(source, property, receiver)
    return typeof value === 'function' ? value.bind(source) : value
  },
}) as PrismaClient
