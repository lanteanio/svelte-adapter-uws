import type { WebSocketHandler } from 'svelte-adapter-uws';

type UserData = { userId: string };

export const subscriptionHandlers = [
  { subscribe: async (ws, topic, { platform }) => {
    const userId: string = ws.getUserData().userId;
    const connections: number = platform.connections;
    await Promise.resolve();
    return userId && topic && connections ? false : 'UNAUTHENTICATED';
  } },
  { subscribe: async () => {} },
  { subscribe: () => true },
  { subscribeBatch: async (ws, topics, { platform }) => {
    const userId: string = ws.getUserData().userId;
    const connections: number = platform.connections;
    await Promise.resolve();
    return { denied: false, reason: 'FORBIDDEN', allowed: true, omitted: undefined,
      [topics[0] || userId]: connections ? false : 'UNAUTHENTICATED' };
  } },
  { subscribeBatch: async () => {} },
  { subscribeBatch: () => ({ denied: false, reason: 'FORBIDDEN', allowed: true, omitted: undefined }) },
  { subscribeBatch: () => {} }
] satisfies WebSocketHandler<UserData>[];

export const invalidSubscriptionHandlers: WebSocketHandler[] = [
  {
    // @ts-expect-error A subscription decision cannot be a number.
    subscribe: async () => 42
  },
  {
    // @ts-expect-error Batch decisions must be booleans, strings, or undefined.
    subscribeBatch: async () => ({ denied: 42 })
  }
];
