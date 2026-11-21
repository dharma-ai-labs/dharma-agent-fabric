import {AsyncLocalStorage} from 'node:async_hooks';
import {withDeviceSigningControl, withSigningControlPerSend, type AgentFabricClient} from '@dharma-ai-labs/agent-fabric-relay-client';

type SigningControlInput = Parameters<typeof withDeviceSigningControl>[0];

const holdingControl = new AsyncLocalStorage<true>();

/** Holds device signing control so that this caller's signed requests skip the admission line below. A caller whose
 * work makes one signed call passes perSend, and each hold then makes at most one network send: when that call first
 * sends another kept request (its client's earlier call, or an orphan that makes room in a full file), the hold ends
 * there and work runs again from its start in a fresh hold, behind every caller that waited meanwhile. Such work does
 * nothing before its signed call that it cannot do again. Without perSend, a caller that holds control across several
 * calls keeps it across their sends. Inside a hold its own caller took, work runs in that hold either way. */
export function withClientSigningControl<T>(input: SigningControlInput, work: () => Promise<T>,
  options: {perSend?: boolean} = {}): Promise<T> {
  return holdingControl.run(true, () => (options.perSend ? withSigningControlPerSend : withDeviceSigningControl)(input, work));
}

/** The pinned client takes signing control at the front of its queue, so a queued request
 * waiting for the control blocks a holder's own request queued behind it, until the
 * signing lock timeout fails the waiter. Each request here takes the control before it
 * enters that queue. The line keeps the queue's order on one client and gives each
 * waiter its full lock timeout once it is next. A holder skips the line, because a
 * waiter ahead of it there cannot move until the holder finishes. Each hold the line
 * takes covers at most one network send: when a request first sends another kept
 * request, it hands the hold back and takes a fresh one, still first in this line. */
export function admitSignedRequests(fabric: AgentFabricClient, hostScope?: SigningControlInput['hostScope']) {
  const {signedGet, signedPost} = fabric;
  let line: Promise<unknown> = Promise.resolve();
  const admit = <T>(request: () => Promise<T>) => {
    const underControl = () => withSigningControlPerSend({config: fabric.config, hostScope}, request);
    if (holdingControl.getStore()) return underControl();
    const turn = line.then(underControl);
    line = turn.catch(() => undefined);
    return turn;
  };
  fabric.signedGet = route => admit(() => signedGet.call(fabric, route));
  fabric.signedPost = (route, body) => admit(() => signedPost.call(fabric, route, body));
  return fabric;
}
