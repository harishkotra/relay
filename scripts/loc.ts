// Prints the same numbers the server reports at runtime, from the same code, so
// `npm run loc` output can be pasted next to a screenshot of the UI as proof.

import { readServerFile } from '../server/loc.js';

const files = ['handrolled', 'strands', 'strands-trace', 'tools', 'agent-spec', 'loc', 'config'];
const rows: string[] = [];
for (const name of files) {
  const { path, report } = await readServerFile(name);
  rows.push(
    [String(report.loc).padStart(4), String(report.commentOnlyLines).padStart(5), String(report.blankLines).padStart(5), String(report.totalLines).padStart(5), path.replace(`${process.cwd()}/`, '')]
      .join('  '),
  );
}
console.log('code  comment  blank  total  file');
console.log(rows.join('\n'));
console.log('\nrule: a line counts when it holds something other than a comment or whitespace.');
console.log('the scanner tracks string/template/comment state, so "https://x" inside a string is code.');
