// Node can classify sandboxed socketpair descriptors as unknown and discard
// child output. Repair only its dummy streams, using their existing fds.
export const namedCodexNodeOutputBody = String.raw`
for (const [name, fd] of [['stdout', 1], ['stderr', 2]]) {
  const current = process[name];
  if (current.constructor !== Writable || current._handle || current._type || !fstatSync(fd).isSocket()) continue;
  const stream = new Writable({
    write(chunk, encoding, callback) {
      try {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        let offset = 0;
        while (offset < data.length) {
          const count = writeSync(fd, data, offset, data.length - offset);
          if (!Number.isInteger(count) || count <= 0 || count > data.length - offset) {
            throw new Error('named_node_output_descriptor_no_progress');
          }
          offset += count;
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
  stream.fd = fd;
  stream._isStdio = true;
  Object.defineProperty(process, name, { configurable: true, enumerable: true, value: stream });
}
`;

export function namedCodexNodeOutputArguments(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'linux') return [];
  const source = "import {writeSync,fstatSync} from 'node:fs';import {Writable} from 'node:stream';\n" + namedCodexNodeOutputBody;
  const options = '--import=data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  // This fixed public module replaces, rather than forwards, user NODE_OPTIONS.
  return ['-c', `shell_environment_policy.set={NODE_OPTIONS=${JSON.stringify(options)}}`];
}
