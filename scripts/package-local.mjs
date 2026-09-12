#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const manifestPath = path.resolve('manifest.json');
const mainPath = path.resolve('main.js');
const stylesPath = path.resolve('styles.css');

const requiredFiles = [
  { path: manifestPath, name: 'manifest.json' },
  { path: mainPath, name: 'main.js' },
  { path: stylesPath, name: 'styles.css' },
];

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`Failed to read manifest.json: ${e.message}`);
  process.exit(1);
}

const { id, version } = manifest;
if (!id || !version) {
  console.error('manifest.json must contain "id" and "version"');
  process.exit(1);
}

const missing = requiredFiles.filter(f => !fs.existsSync(f.path));
if (missing.length > 0) {
  console.error('Missing required files:');
  for (const f of missing) {
    console.error(`  - ${f.name}`);
  }
  process.exit(1);
}

const distDir = path.resolve('dist', id);
fs.mkdirSync(distDir, { recursive: true });

for (const f of requiredFiles) {
  const dest = path.join(distDir, f.name);
  fs.copyFileSync(f.path, dest);
  console.log(`Copied ${f.name} -> ${dest}`);
}

const zipName = `${id}-${version}.zip`;
const zipPath = path.resolve('dist', zipName);

const zipResult = spawnSync('zip', ['-r', zipPath, '.'], {
  cwd: distDir,
  stdio: 'inherit',
});

if (zipResult.status !== 0) {
  if (zipResult.error && zipResult.error.code === 'ENOENT') {
    console.warn('Warning: `zip` command not found, skipping zip creation');
  } else {
    console.error(`zip command failed with exit code ${zipResult.status}`);
    process.exit(1);
  }
} else {
  console.log(`Created zip: ${zipPath}`);
}

console.log('\nOutput:');
console.log(`  Directory: ${distDir}`);
if (fs.existsSync(zipPath)) {
  console.log(`  Zip: ${zipPath}`);
}