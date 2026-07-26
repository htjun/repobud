/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { createRequire } from 'node:module';
import { isMacintosh } from '../../../base/common/platform.js';
import { env } from '../../../base/common/process.js';
import { IProductService } from '../../product/common/productService.js';
import { IKeychainCredentialService } from '../common/keychainCredentialService.js';

const keytar: typeof import('keytar') = createRequire(import.meta.url)('keytar');

export class KeychainCredentialMainService implements IKeychainCredentialService {

	declare readonly _serviceBrand: undefined;

	private readonly serviceName: string;

	constructor(@IProductService productService: IProductService) {
		const productId = productService.darwinBundleIdentifier ?? productService.applicationName;
		const testNamespace = env['REPOSITORY_CONTEXT_KEYCHAIN_NAMESPACE'];
		const suffix = app.commandLine.hasSwitch('use-mock-keychain') && testNamespace
			? `.test.${testNamespace.replaceAll(/[^A-Za-z0-9._-]/g, '_')}`
			: '';
		this.serviceName = `${productId}.connections.github${suffix}`;
	}

	async isAvailable(): Promise<boolean> {
		return isMacintosh;
	}

	async get(connectionId: string): Promise<string | undefined> {
		this.assertAvailable();
		try {
			return (await keytar.getPassword(this.serviceName, connectionId)) ?? undefined;
		} catch {
			throw new Error('macOS Keychain could not read the Connection credential.');
		}
	}

	async set(connectionId: string, secret: string): Promise<void> {
		this.assertAvailable();
		if (!secret) {
			throw new Error('A non-empty Connection credential is required.');
		}
		try {
			await keytar.setPassword(this.serviceName, connectionId, secret);
		} catch {
			throw new Error('macOS Keychain could not store the Connection credential.');
		}
	}

	async delete(connectionId: string): Promise<void> {
		this.assertAvailable();
		try {
			await keytar.deletePassword(this.serviceName, connectionId);
		} catch {
			throw new Error('macOS Keychain could not delete the Connection credential.');
		}
	}

	private assertAvailable(): void {
		if (!isMacintosh) {
			throw new Error('macOS Keychain is unavailable.');
		}
	}
}
