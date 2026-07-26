/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Reads and parses a JSON file.
 */
async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Resolves the expected filesystem layout of a packaged application.
 */
export function resolvePackagePaths(packageRoot = process.env.REPOBUD_PACKAGE_ROOT) {
	const resolvedPackageRoot = resolve(
		packageRoot ?? join(repositoryRoot, '..', 'VSCode-darwin-arm64')
	);
	const applicationPath = join(resolvedPackageRoot, 'RepoBud.app');
	return {
		packageRoot: resolvedPackageRoot,
		applicationPath,
		executablePath: join(applicationPath, 'Contents', 'MacOS', 'RepoBud'),
		infoPlistPath: join(applicationPath, 'Contents', 'Info.plist'),
		productPath: join(applicationPath, 'Contents', 'Resources', 'app', 'product.json'),
	};
}

/**
 * Reads a value from a macOS property list.
 */
function readPlistValue(infoPlistPath, key) {
	return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, infoPlistPath], {
		encoding: 'utf8',
	}).trim();
}

/**
 * Returns the CPU architectures contained in a Mach-O executable.
 */
function readArchitectures(executablePath) {
	return execFileSync('/usr/bin/lipo', ['-archs', executablePath], { encoding: 'utf8' })
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * Verifies the complete application signature using strict macOS checks.
 */
function verifyStrictSignature(applicationPath) {
	execFileSync('/usr/bin/codesign', [
		'--verify',
		'--deep',
		'--strict',
		'--verbose=2',
		applicationPath,
	], { stdio: 'pipe' });
}

/**
 * Verifies package identity, provenance, platform support, and signing integrity.
 */
export async function verifyRepoBudPackage(options = {}) {
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
	const minimumSystemVersion = readPlistValue(paths.infoPlistPath, 'LSMinimumSystemVersion');
	const iconFile = readPlistValue(paths.infoPlistPath, 'CFBundleIconFile');
	const architectures = readArchitectures(paths.executablePath);

	assert.equal(sourceProduct.nameShort, 'RepoBud');
	assert.equal(sourceProduct.nameLong, 'RepoBud');
	assert.equal(sourceProduct.applicationName, 'repobud');
	assert.equal(sourceProduct.dataFolderName, '.repobud');
	assert.equal(sourceProduct.sharedDataFolderName, '.repobud-shared');
	assert.equal(sourceProduct.darwinBundleIdentifier, 'dev.htjun.repobud');
	assert.equal(sourceProduct.darwinIcon, 'resources/darwin/repobud.icns');
	assert.equal(sourceProduct.urlProtocol, 'repobud');
	assert.equal(sourcePackage.name, 'repobud');
	assert.equal(packagedProduct.nameShort, sourceProduct.nameShort);
	assert.equal(packagedProduct.nameLong, sourceProduct.nameLong);
	assert.equal(packagedProduct.applicationName, sourceProduct.applicationName);
	assert.equal(packagedProduct.darwinBundleIdentifier, sourceProduct.darwinBundleIdentifier);
	assert.equal(packagedProduct.darwinMinimumSystemVersion, sourceProduct.darwinMinimumSystemVersion);
	assert.equal(bundleIdentifier, sourceProduct.darwinBundleIdentifier);
	assert.equal(bundleName, sourceProduct.nameShort);
	assert.equal(minimumSystemVersion, sourceProduct.darwinMinimumSystemVersion);
	assert.equal(iconFile, `${sourceProduct.nameShort}.icns`);
	for (const privacyKey of sourceProduct.darwinRemovedPrivacyUsageDescriptions) {
		assert.throws(
			() => readPlistValue(paths.infoPlistPath, privacyKey),
			`The package still declares unused privacy usage description ${privacyKey}.`
		);
	}
	assert.equal(packagedProduct.version, sourcePackage.version);
	assert.equal(packagedProduct.updateUrl, undefined, 'The update service must remain disabled for preview packages.');
	assert.doesNotMatch(
		JSON.stringify(packagedProduct),
		/vscode-cdn\.net/i,
		'The focused package must not use the Microsoft webview CDN.'
	);
	assert.ok(
		architectures.includes('arm64'),
		`The packaged executable must contain arm64, found: ${architectures.join(', ')}`
	);
	assert.doesNotMatch(
		`${packagedProduct.nameShort} ${packagedProduct.nameLong} ${bundleName}`,
		/\b(?:Code - OSS|Visual Studio Code|VS Code)\b/i,
		'The packaged application exposes an upstream product identity.'
	);
	verifyStrictSignature(paths.applicationPath);

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
		minimumSystemVersion,
		architectures,
	};
}
