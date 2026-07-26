/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

export function resolvePackagePaths(packageRoot = process.env.REPOSITORY_CONTEXT_PACKAGE_ROOT) {
	const resolvedPackageRoot = resolve(
		packageRoot ?? join(repositoryRoot, '..', 'VSCode-darwin-arm64')
	);
	const applicationPath = join(resolvedPackageRoot, 'Repository Context Workbench.app');
	return {
		packageRoot: resolvedPackageRoot,
		applicationPath,
		executablePath: join(applicationPath, 'Contents', 'MacOS', 'Repository Context'),
		infoPlistPath: join(applicationPath, 'Contents', 'Info.plist'),
		productPath: join(applicationPath, 'Contents', 'Resources', 'app', 'product.json'),
	};
}

function readPlistValue(infoPlistPath, key) {
	return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, infoPlistPath], {
		encoding: 'utf8',
	}).trim();
}

function readArchitectures(executablePath) {
	return execFileSync('/usr/bin/lipo', ['-archs', executablePath], { encoding: 'utf8' })
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

export async function verifyRepositoryContextPackage(options = {}) {
	const paths = resolvePackagePaths(options.packageRoot);
	const [sourceProduct, sourcePackage, packagedProduct] = await Promise.all([
		readJson(join(repositoryRoot, 'product.json')),
		readJson(join(repositoryRoot, 'package.json')),
		readJson(paths.productPath),
	]);

	const expectedCommit = options.expectedCommit ?? execFileSync(
		'git',
		['rev-parse', 'HEAD'],
		{ cwd: repositoryRoot, encoding: 'utf8' }
	).trim();
	const bundleIdentifier = readPlistValue(paths.infoPlistPath, 'CFBundleIdentifier');
	const bundleName = readPlistValue(paths.infoPlistPath, 'CFBundleName');
	const architectures = readArchitectures(paths.executablePath);

	assert.equal(sourceProduct.nameShort, 'Repository Context');
	assert.equal(sourceProduct.nameLong, 'Repository Context Workbench');
	assert.equal(sourceProduct.applicationName, 'repository-context');
	assert.equal(packagedProduct.nameShort, sourceProduct.nameShort);
	assert.equal(packagedProduct.nameLong, sourceProduct.nameLong);
	assert.equal(packagedProduct.applicationName, sourceProduct.applicationName);
	assert.equal(packagedProduct.darwinBundleIdentifier, sourceProduct.darwinBundleIdentifier);
	assert.equal(bundleIdentifier, sourceProduct.darwinBundleIdentifier);
	assert.equal(bundleName, sourceProduct.nameShort);
	assert.equal(packagedProduct.version, sourcePackage.version);
	assert.ok(
		architectures.includes('arm64'),
		`The packaged executable must contain arm64, found: ${architectures.join(', ')}`
	);
	assert.doesNotMatch(
		`${packagedProduct.nameShort} ${packagedProduct.nameLong} ${bundleName}`,
		/\b(?:Code - OSS|Visual Studio Code|VS Code)\b/i,
		'The packaged application exposes an upstream product identity.'
	);

	const isCurrent = packagedProduct.commit === expectedCommit;
	if (!isCurrent && !options.allowStale) {
		throw new Error(
			`The packaged application was built from ${packagedProduct.commit ?? 'an unknown commit'}, ` +
			`but the source checkout is ${expectedCommit}. Run "npm run package:macos" first.`
		);
	}

	return {
		...paths,
		name: packagedProduct.nameLong,
		version: packagedProduct.version,
		commit: packagedProduct.commit,
		expectedCommit,
		isCurrent,
		bundleIdentifier,
		architectures,
	};
}
