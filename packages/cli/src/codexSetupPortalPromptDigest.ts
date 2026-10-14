import {createHash} from 'node:crypto';

/** The single public checksum argument is zeroed to avoid a self-referential digest. */
export function codexSetupPortalPromptDigest(value: unknown): string {
  const invalid=():never=>{throw new Error('codex_setup_public_prompt_invalid');};
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>32768
    ||Buffer.from(value,'utf8').toString('utf8')!==value
    ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))return invalid();
  const text=value.replace(/\r\n/g,'\n');
  if([...text.matchAll(/--portal-prompt-sha256\b/g)].length!==1)return invalid();
  const matches=[...text.matchAll(/--portal-prompt-sha256 ([a-f0-9]{64})(?=[ \t\n]|$)/g)];
  if(matches.length!==1)return invalid();
  const match=matches[0]!,at=match.index!+match[0].length-64;
  return createHash('sha256').update(text.slice(0,at)+'0'.repeat(64)+text.slice(at+64),'utf8').digest('hex');
}
