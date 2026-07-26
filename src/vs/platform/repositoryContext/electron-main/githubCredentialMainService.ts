/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { env } from '../../../base/common/process.js';
import { IProductService } from '../../product/common/productService.js';
import {
	IGitHubCredentialService,
	IGitHubCredentialValidation,
} from '../common/githubCredentialService.js';

const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_GITHUB_USER_URL = 'https://api.github.com/user';

export class GitHubCredentialMainService implements IGitHubCredentialService {

	declare readonly _serviceBrand: undefined;

	private readonly userUrl: string;
	private readonly userAgent: string;

	constructor(@IProductService productService: IProductService) {
		this.userUrl = this.resolveUserUrl();
		this.userAgent = `Repository-Context-Workbench/${productService.version}`;
	}

	async validate(token: string): Promise<IGitHubCredentialValidation> {
		const response = await fetch(this.userUrl, {
			method: 'GET',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'X-GitHub-Api-Version': GITHUB_API_VERSION,
				'User-Agent': this.userAgent,
			},
			signal: AbortSignal.timeout(10_000),
		});
		const expiresAt = this.parseExpiration(
			response.headers.get('github-authentication-token-expiration')
		);
		if (response.status === 401) {
			return {
				state: expiresAt !== undefined && expiresAt <= Date.now() ? 'expired' : 'rejected',
				scopes: [],
				expiresAt,
			};
		}
		if (!response.ok) {
			throw new Error(`GitHub credential validation failed with status ${response.status}.`);
		}
		let account: { id?: unknown; login?: unknown };
		try {
			account = await response.json() as { id?: unknown; login?: unknown };
		} catch {
			throw new Error('GitHub credential validation returned malformed JSON.');
		}
		if (typeof account.id !== 'number' || typeof account.login !== 'string') {
			throw new Error('GitHub credential validation returned an invalid account response.');
		}
		return {
			state: expiresAt !== undefined && expiresAt <= Date.now() ? 'expired' : 'valid',
			accountId: String(account.id),
			accountLabel: account.login,
			scopes: (response.headers.get('x-oauth-scopes') ?? '')
				.split(',')
				.map(scope => scope.trim())
				.filter(Boolean)
				.sort(),
			expiresAt,
		};
	}

	private resolveUserUrl(): string {
		const testUrl = env['REPOSITORY_CONTEXT_GITHUB_USER_URL'];
		if (!testUrl || !app.commandLine.hasSwitch('use-mock-keychain')) {
			return DEFAULT_GITHUB_USER_URL;
		}
		const parsed = new URL(testUrl);
		if (
			parsed.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
		) {
			throw new Error('The GitHub test endpoint must be a loopback HTTP URL.');
		}
		return parsed.toString();
	}

	private parseExpiration(value: string | null): number | undefined {
		if (!value) {
			return undefined;
		}
		const timestamp = Date.parse(value);
		return Number.isNaN(timestamp) ? undefined : timestamp;
	}
}
