import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {codexSetupPortalPromptDigest} from './codexSetupPortalPromptDigest.js';

const empty='0'.repeat(64);
const template='# Public setup specification\nRun the official entry --portal-prompt-sha256 '+empty+'\n';
const expected=createHash('sha256').update(template).digest('hex');
test('portal prompt checksum masks only its single checksum argument, not other instructions',()=>{
  assert.equal(codexSetupPortalPromptDigest(template),expected);
  const filled=template.replace(empty,expected);
  assert.equal(codexSetupPortalPromptDigest(filled),expected);
  assert.equal(codexSetupPortalPromptDigest(filled.replaceAll('\n','\r\n')),expected);
  assert.notEqual(codexSetupPortalPromptDigest(filled.replace('official','foreign')),expected);
  assert.notEqual(codexSetupPortalPromptDigest(filled+'Extra instruction\n'),expected);
});
for(const value of [null,'',template.replace('--portal-prompt-sha256 ','--unknown '),
  template+template,template.replace(empty,'g'.repeat(64)),template.replace(empty,empty+'a'),
  template.replace(empty,empty+'\0'),template+'x'.repeat(32768)]){
  test('malformed or ambiguous checksum input is not accepted: '+String(value).slice(0,45),()=>{
    assert.throws(()=>codexSetupPortalPromptDigest(value),/^Error: codex_setup_public_prompt_invalid$/);
  });
}
