/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import {
	IMcpHealthRequest,
	IMcpHealthResult,
	IMcpStdioHealthTransport,
	IRepoBudMcpHealthService,
} from '../common/mcpHealth.js';

const initializeRequest = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: {
			name: 'repobud',
			version: '1.0.0',
		},
	},
};

interface IMcpInitializeResponse {
	readonly result?: {
		readonly protocolVersion?: unknown;
		readonly capabilities?: unknown;
	};
	readonly error?: {
		readonly message?: unknown;
	};
}

export class RepoBudMcpHealthMainService implements IRepoBudMcpHealthService {

	declare readonly _serviceBrand: undefined;

	async check(request: IMcpHealthRequest): Promise<IMcpHealthResult> {
		const checkedAt = Date.now();
		try {
			const response = request.transport.type === 'stdio'
				? await this.checkStdio(request.transport, request.repository)
				: await this.checkHttp(request.transport.url);
			if (response.error) {
				throw new Error('The MCP server returned an initialization error.');
			}
			return {
				state: 'healthy',
				checkedAt,
				protocolVersion: typeof response.result?.protocolVersion === 'string'
					? response.result.protocolVersion
					: undefined,
				capabilities: this.getCapabilities(response.result?.capabilities),
			};
		} catch (error) {
			return {
				state: 'unreachable',
				checkedAt,
				capabilities: [],
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async checkStdio(
		transport: IMcpStdioHealthTransport,
		repository: URI | undefined,
	): Promise<IMcpInitializeResponse> {
		if (!transport.command.trim()) {
			throw new Error('The MCP stdio command is empty.');
		}
		if (repository && repository.scheme !== Schemas.file) {
			throw new Error('MCP stdio health checks require a local repository.');
		}
		const child = spawn(transport.command, [...transport.args], {
			cwd: repository?.fsPath,
			env: this.createMinimalEnvironment(),
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return this.exchangeStdioInitialize(child);
	}

	private exchangeStdioInitialize(child: ChildProcessWithoutNullStreams): Promise<IMcpInitializeResponse> {
		return new Promise((resolve, reject) => {
			let stdout = '';
			let settled = false;
			const finish = (error?: Error, response?: IMcpInitializeResponse) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				child.kill();
				if (error) {
					reject(error);
				} else {
					resolve(response ?? {});
				}
			};
			const timeout = setTimeout(() => finish(new Error('MCP stdio initialization timed out.')), 5000);
			child.once('error', error => finish(error));
			child.once('exit', code => {
				if (!settled) {
					finish(new Error(`MCP stdio server exited before initialization (${code ?? 'unknown'}).`));
				}
			});
			child.stderr.resume();
			child.stdout.on('data', chunk => {
				stdout += chunk;
				if (stdout.length > 1024 * 1024) {
					finish(new Error('MCP stdio initialization exceeded the output limit.'));
					return;
				}
				const lineEnd = stdout.indexOf('\n');
				if (lineEnd < 0) {
					return;
				}
				const line = stdout.slice(0, lineEnd).trim();
				try {
					finish(undefined, JSON.parse(line) as IMcpInitializeResponse);
				} catch {
					finish(new Error('MCP stdio server returned invalid JSON.'));
				}
			});
			child.stdin.end(`${JSON.stringify(initializeRequest)}\n`);
		});
	}

	private async checkHttp(url: string): Promise<IMcpInitializeResponse> {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
			throw new Error('MCP HTTP endpoint must use HTTP or HTTPS.');
		}
		const response = await fetch(parsedUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(initializeRequest),
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			throw new Error(`MCP HTTP initialization failed with status ${response.status}.`);
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('text/event-stream')) {
			const data = (await response.text())
				.split(/\r?\n/)
				.find(line => line.startsWith('data:'));
			if (!data) {
				throw new Error('MCP HTTP server returned no initialization event.');
			}
			return JSON.parse(data.slice('data:'.length).trim()) as IMcpInitializeResponse;
		}
		return await response.json() as IMcpInitializeResponse;
	}

	private getCapabilities(value: unknown): string[] {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return [];
		}
		return Object.keys(value).sort();
	}

	private createMinimalEnvironment(): NodeJS.ProcessEnv {
		return Object.fromEntries(
			['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR']
				.flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])
		);
	}
}
