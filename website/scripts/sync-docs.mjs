// Keeps the repo's top-level docs/*.md (the single source of truth, read on
// GitHub directly) in sync with the Starlight content collection used to
// render the site. Runs automatically before `dev` and `build` — never edit
// files under src/content/docs/ directly, edit docs/*.md instead.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(__dirname, '..', '..', 'docs');
const DEST_DIR = join(__dirname, '..', 'src', 'content', 'docs');

mkdirSync(DEST_DIR, { recursive: true });

function yamlEscape(value) {
  return value.replace(/"/g, '\\"');
}

const files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.md'));

for (const file of files) {
  const raw = readFileSync(join(SOURCE_DIR, file), 'utf-8');
  const lines = raw.split('\n');

  let title = file.replace(/\.md$/, '');
  let bodyStart = 0;
  if (lines[0]?.startsWith('# ')) {
    title = lines[0].slice(2).trim();
    bodyStart = 1;
    while (lines[bodyStart] === '') bodyStart++;
  }

  const body = lines.slice(bodyStart).join('\n');
  const frontmatter = `---\ntitle: "${yamlEscape(title)}"\n---\n\n`;

  writeFileSync(join(DEST_DIR, file), frontmatter + body, 'utf-8');
}

console.log(`sync-docs: wrote ${files.length} page(s) to src/content/docs/`);
