/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import vfs from 'vinyl-fs';
import { filter, jsonEditor } from './gulp/facade.ts';
import * as util from './util.ts';
import { getVersion } from './getVersion.ts';
import { downloadFeedPackage } from './azureFeed.ts';
import electron from '@vscode/gulp-electron';

type DarwinDocumentSuffix = 'document' | 'script' | 'file' | 'source code';
type DarwinDocumentType = {
	name: string;
	role: string;
	ostypes: string[];
	extensions: string[];
	iconFile: string;
	utis?: string[];
};

function isDocumentSuffix(str?: string): str is DarwinDocumentSuffix {
	return str === 'document' || str === 'script' || str === 'file' || str === 'source code';
}

const root = path.dirname(path.dirname(import.meta.dirname));
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
const commit = getVersion(root);
const useVersionedUpdate = process.platform === 'win32' && (product as typeof product & { win32VersionedUpdate?: boolean })?.win32VersionedUpdate;
const versionedResourcesFolder = useVersionedUpdate ? commit!.substring(0, 10) : '';

function createTemplate(input: string): (params: Record<string, string>) => string {
	return (params: Record<string, string>) => {
		return input.replace(/<%=\s*([^\s]+)\s*%>/g, (match, key) => {
			return params[key] || match;
		});
	};
}

const darwinCreditsTemplate = product.darwinCredits && createTemplate(fs.readFileSync(path.join(root, product.darwinCredits), 'utf8'));

/**
 * Generate a `DarwinDocumentType` given a list of file extensions, an icon name, and an optional suffix or file type name.
 * @param extensions A list of file extensions, such as `['bat', 'cmd']`
 * @param icon A sentence-cased file type name that matches the lowercase name of a darwin icon resource.
 * For example, `'HTML'` instead of `'html'`, or `'Java'` instead of `'java'`.
 * This parameter is lowercased before it is used to reference an icon file.
 * @param nameOrSuffix An optional suffix or a string to use as the file type. If a suffix is provided,
 * it is used with the icon parameter to generate a file type string. If nothing is provided,
 * `'document'` is used with the icon parameter to generate file type string.
 *
 * For example, if you call `darwinBundleDocumentType(..., 'HTML')`, the resulting file type is `"HTML document"`,
 * and the `'html'` darwin icon is used.
 *
 * If you call `darwinBundleDocumentType(..., 'Javascript', 'file')`, the resulting file type is `"Javascript file"`.
 * and the `'javascript'` darwin icon is used.
 *
 * If you call `darwinBundleDocumentType(..., 'bat', 'Windows command script')`, the file type is `"Windows command script"`,
 * and the `'bat'` darwin icon is used.
 */
function darwinBundleDocumentType(extensions: string[], icon: string, nameOrSuffix?: string | DarwinDocumentSuffix, utis?: string[]): DarwinDocumentType {
	// If given a suffix, generate a name from it. If not given anything, default to 'document'
	if (isDocumentSuffix(nameOrSuffix) || !nameOrSuffix) {
		nameOrSuffix = icon.charAt(0).toUpperCase() + icon.slice(1) + ' ' + (nameOrSuffix ?? 'document');
	}

	return {
		name: nameOrSuffix,
		role: 'Viewer',
		ostypes: ['TEXT', 'utxt', 'TUTX', '****'],
		extensions,
		iconFile: 'resources/darwin/' + icon.toLowerCase() + '.icns',
		utis
	};
}

const { electronVersion, msBuildId } = util.getElectronVersion();

// In product builds, `@vscode/gulp-electron` is given an asset resolver (via the
// `repo` option) that fetches the prebuilt Electron archives on demand from the
// Azure Artifacts feed named by `product.electronArtifactFeed` using the `az`
// CLI, instead of downloading them from electron's official GitHub releases
// (which OSS builds use when no feed is configured). Each universal package
// contains exactly one file, which is streamed back as a `Response` and
// validated against the feed's `SHASUMS256.txt`.
const electronFeed: string | undefined = product.electronArtifactFeed;

// Maps the artifact file name `@vscode/gulp-electron` requests to the matching
// universal package name in the feed, or `undefined` when it is not mirrored.
function feedPackageName(fileName: string): string | undefined {
	if (fileName === 'SHASUMS256.txt') {
		return 'shasums256';
	}
	if (fileName.endsWith('-symbols.zip')) {
		return undefined;
	}
	return fileName.replace(/\.zip$/, '');
}

const electronAssetResolver = electronFeed
	? async ({ fileName }: { url: string; fileName: string }): Promise<Response> => {
		const name = feedPackageName(fileName);
		if (!name) {
			return new Response(null, { status: 404 });
		}
		const version = `${electronVersion}-${msBuildId}`;
		const filePath = await downloadFeedPackage(root, 'electron-feed', { feed: electronFeed, name, version });
		const size = (await fs.promises.stat(filePath)).size;
		const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
		return new Response(body, { status: 200, headers: { 'Content-Length': String(size) } });
	}
	: undefined;

export const config = {
	version: electronVersion,
	productAppName: product.nameLong,
	companyName: product.companyName,
	copyright: product.copyright,
	darwinExecutable: product.nameShort,
	darwinIcon: product.darwinIcon,
	darwinBundleIdentifier: product.darwinBundleIdentifier,
	darwinApplicationCategoryType: 'public.app-category.developer-tools',
	darwinHelpBookFolder: `${product.nameLong} HelpBook`,
	darwinHelpBookName: `${product.nameLong} HelpBook`,
	darwinBundleDocumentTypes: [
		darwinBundleDocumentType([], 'default', 'Folder', ['public.folder'])
	],
	darwinBundleURLTypes: [{
		role: 'Viewer',
		name: product.nameLong,
		urlSchemes: [product.urlProtocol]
	}],
	darwinForceDarkModeSupport: true,
	darwinCredits: darwinCreditsTemplate ? Buffer.from(darwinCreditsTemplate({ commit: commit, date: new Date().toISOString() })) : undefined,
	linuxExecutableName: product.applicationName,
	winIcon: product.winIcon,
	token: process.env['GITHUB_TOKEN'],
	repo: electronAssetResolver,
	validateChecksum: true,
	checksumFile: path.join(root, 'build', 'checksums', 'electron.txt'),
	createVersionedResources: useVersionedUpdate,
	productVersionString: versionedResourcesFolder,
};

function getElectron(arch: string): () => NodeJS.ReadWriteStream {
	return () => {
		const electronOpts = {
			...config,
			platform: process.platform,
			arch: arch === 'armhf' ? 'arm' : arch,
			ffmpegChromium: false,
			keepDefaultApp: true
		};

		return vfs.src('package.json')
			.pipe(jsonEditor({ name: product.nameShort }))
			.pipe(electron(electronOpts))
			.pipe(filter(['**', '!**/app/package.json']))
			.pipe(vfs.dest('.build/electron'));
	};
}

async function main(arch: string = process.arch): Promise<void> {
	const electronPath = path.join(root, '.build', 'electron');
	await util.rimraf(electronPath)();
	await util.streamToPromise(getElectron(arch)());
}

if (import.meta.main) {
	main(process.argv[2]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
