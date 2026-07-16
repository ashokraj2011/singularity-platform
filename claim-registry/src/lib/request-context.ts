import { AsyncLocalStorage } from 'node:async_hooks';

export type RegistryActor = {
  userId: string;
  tenantId: string;
  kind: 'user' | 'service';
};

const storage = new AsyncLocalStorage<RegistryActor>();

export function runWithRegistryActor<T>(actor: RegistryActor, callback: () => T): T {
  return storage.run(actor, callback);
}

export function currentRegistryActor(): RegistryActor {
  const actor = storage.getStore();
  if (!actor) throw new Error('Claim Registry request context is missing');
  return actor;
}

export function currentRegistryTenant(): string {
  return currentRegistryActor().tenantId;
}
