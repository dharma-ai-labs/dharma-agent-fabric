import {AsyncLocalStorage} from 'node:async_hooks';
import {withDeviceSigningControl, type AgentFabricClient} from '@dharma-ai-labs/agent-fabric-relay-client';

type SigningControlInput = Parameters<typeof withDeviceSigningControl>[0];

const holdingControl = new AsyncLocalStorage<true>();

/** Holds device signing control so that this caller's signed requests skip the admission line below. */
export function withClientSigningControl<T>(input: SigningControlInput, work: () => Promise<T>): Promise<T> {
  return holdingControl.run(true, () => withDeviceSigningControl(input, work));
}

/** The pinned client takes signing control at the front of its queue, so a queued request
 * waiting for the control blocks a holder's own request queued behind it, until the
 * signing lock timeout fails the waiter. Each request here takes the control before it
 * enters that queue. The line keeps the queue's order on one client and gives each
 * waiter its full lock timeout once it is next. A holder skips the line, because a
 * waiter ahead of it there cannot move until the holder finishes. */
export function admitSignedRequests(fabric: AgentFabricClient, hostScope?: SigningControlInput['hostScope']) {
  const {signedGet, signedPost} = fabric;
  let line: Promise<unknown> = Promise.resolve();
  const admit = <T>(request: () => Promise<T>) => {
    const underControl = () => withDeviceSigningControl({config: fabric.config, hostScope}, request);
    if (holdingControl.getStore()) return underControl();
    const turn = line.then(underControl);
    line = turn.catch(() => undefined);
    return turn;
  };
  fabric.signedGet = route => admit(() => signedGet.call(fabric, route));
  fabric.signedPost = (route, body) => admit(() => signedPost.call(fabric, route, body));
  return fabric;
}
