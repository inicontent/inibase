// Run the existing package suite without tsx CLI's optional IPC socket server.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const files = manifest.scripts.test.split(' && ').map(command => {
 if (!command.startsWith('tsx ./tests/')) throw new Error(`Unsupported test command: ${command}`);
 return command.slice(4);
});
files.push('./tests/storage-process.test.ts', './tests/journal-hardening.test.ts');
let failures = 0;
for (const file of files) {
 console.log(`\nCHECK ${file}`);
 const result = spawnSync(process.execPath, ['--import', 'tsx', file], {stdio: 'inherit'});
 if (result.error) console.error(result.error);
 if (result.status !== 0) failures++;
}
console.log(JSON.stringify({files:files.length, failedFiles:failures}));
process.exitCode = failures ? 1 : 0;
