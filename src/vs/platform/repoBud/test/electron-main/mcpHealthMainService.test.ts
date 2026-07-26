/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { RepoBudMcpHealthMainService } from '../../electron-main/mcpHealthMainService.js';

suite('RepoBudMcpHealthMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let fixtureRoot: string;
	let service: RepoBudMcpHealthMainService;

	setup(async () => {
		fixtureRoot = await fs.mkdtemp(join(tmpdir(), 'repobud-mcp-health-'));
		service = new RepoBudMcpHealthMainService();
	});

	teardown(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	test('initializes a stdio server with a minimal environment', async () => {
		const server = join(fixtureRoot, 'server.mjs');
		await fs.writeFile(server, [
			'import readline from \'node:readline\';',
			'const lines = readline.createInterface({ input: process.stdin });',
			'lines.once("line", line => {',
			'  const request = JSON.parse(line);',
			'  const capabilities = process.env.REPOBUD_TEST_SECRET ? { leaked: {} } : { tools: {}, resources: {} };',
			'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities } }) + "\\n");',
			'});',
		].join('\n'));
		process.env.REPOBUD_TEST_SECRET = 'must-not-leak';
		try {
			const result = await service.check({
				id: 'local-tools',
				transport: {
					type: 'stdio',
					command: process.execPath,
					args: [server],
				},
				repository: URI.file(fixtureRoot),
			});
			assert.strictEqual(result.state, 'healthy');
			assert.strictEqual(result.protocolVersion, '2025-06-18');
			assert.deepStrictEqual(result.capabilities, ['resources', 'tools']);
		} finally {
			delete process.env.REPOBUD_TEST_SECRET;
		}
	});

	test('initializes a streamable HTTP endpoint', async () => {
		const { createServer } = await import('http');
		const server = createServer((request, response) => {
			assert.strictEqual(request.method, 'POST');
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-06-18',
					capabilities: { prompts: {}, tools: {} },
				},
			}));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			const result = await service.check({
				id: 'remote-docs',
				transport: {
					type: 'http',
					url: `http://127.0.0.1:${address.port}/mcp`,
				},
			});
			assert.strictEqual(result.state, 'healthy');
			assert.deepStrictEqual(result.capabilities, ['prompts', 'tools']);
		} finally {
			server.close();
		}
	});

	test('returns unreachable without throwing or persisting server output', async () => {
		const result = await service.check({
			id: 'missing',
			transport: {
				type: 'stdio',
				command: join(fixtureRoot, 'missing-command'),
				args: [],
			},
		});
		assert.strictEqual(result.state, 'unreachable');
		assert.deepStrictEqual(result.capabilities, []);
		assert.ok(result.detail);
	});
});
