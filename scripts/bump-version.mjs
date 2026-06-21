/**
 * 统一更新项目版本号（同步 package.json / tauri.conf.json / Cargo.toml）
 *
 * 用法:
 *   node scripts/bump-version.mjs [patch|minor|major]
 *
 * 默认 patch，完整执行：npm version → 同步其余文件 → git commit + tag
 *
 * 仅同步（不 commit/tag）传 --sync-only:
 *   node scripts/bump-version.mjs minor --sync-only
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const type = process.argv[2] || 'patch';
const syncOnly = process.argv.includes('--sync-only');

// 1) npm version 更新 package.json
execSync(`npm version ${type} --no-git-tag-version`, { stdio: 'inherit' });

// 2) 读取新版本
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const ver = pkg.version;
console.log(`\n新版本: ${ver}\n`);

// 3) 同步 tauri.conf.json
const tauriConf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
tauriConf.version = ver;
writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(tauriConf, null, 2) + '\n');
console.log('  ✔ src-tauri/tauri.conf.json');

// 4) 同步 Cargo.toml
let cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/^version = ".*"/m, `version = "${ver}"`);
writeFileSync('src-tauri/Cargo.toml', cargo);
console.log('  ✔ src-tauri/Cargo.toml');

// 5) 提交 + tag
if (!syncOnly) {
  execSync('git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json', { stdio: 'inherit' });
  execSync(`git commit -m "chore: bump version to ${ver}"`, { stdio: 'inherit' });
  execSync(`git tag v${ver}`, { stdio: 'inherit' });
  console.log(`\n  ✔ git commit & tag v${ver}\n`);
}

console.log(`✔ 版本已升级到 ${ver}`);
