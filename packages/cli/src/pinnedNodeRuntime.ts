// Red-first stub for #398; the implementation follows in the next commit.
export const PINNED_NODE_VERSION = '0.0.0';

export type PinnedNodeArchive = {
  file: string; directory: string; executable: string; sha256: string; url: string;
};

export function pinnedNodeArchive(_platform: NodeJS.Platform, _arch: string): PinnedNodeArchive | null {
  return null;
}

export async function ensurePinnedNodeRuntime(_input: {
  dharmaHome: string; archive?: PinnedNodeArchive; platform?: NodeJS.Platform;
  download?: (url: string) => Promise<Buffer>;
  extract?: (file: string, destination: string) => Promise<void>;
  runtimeVersion?: (executable: string) => string;
}): Promise<string> {
  throw new Error('node_runtime_not_implemented');
}
