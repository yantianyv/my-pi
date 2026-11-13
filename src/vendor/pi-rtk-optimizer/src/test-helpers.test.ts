import { mock as nodeTestMockRaw } from "node:test";

import { DEFAULT_RTK_INTEGRATION_CONFIG, type RtkIntegrationConfig } from "./types.ts";

type TestResult = void | Promise<void>;
type MockModuleOptions = { namedExports?: Record<string, unknown>; defaultExport?: unknown };

function isPromiseLike(value: TestResult): value is Promise<void> {
	return Boolean(value && typeof (value as Promise<void>).then === "function");
}

export function runTest(name: string, testFn: () => TestResult): TestResult {
	const result = testFn();
	if (!isPromiseLike(result)) {
		console.log(`[PASS] ${name}`);
		return;
	}

	return result.then(() => {
		console.log(`[PASS] ${name}`);
	});
}

export function cloneDefaultConfig(): RtkIntegrationConfig {
	return structuredClone(DEFAULT_RTK_INTEGRATION_CONFIG);
}

// Runtime-agnostic module-mocking helper. The tests use the node:test-shaped
// API (`mock.module(specifier, { namedExports, defaultExport })`). Bun's
// implementation of `node:test` does not expose `mock.module`, but `bun:test`
// provides an equivalent that accepts a factory function. We detect the
// capability and adapt the options form to the factory form when needed.
const nodeTestMock = nodeTestMockRaw as unknown as { module?: unknown };

let mockModuleImpl: (specifier: string, options: MockModuleOptions) => void;

if (typeof nodeTestMock.module === "function") {
	mockModuleImpl = nodeTestMock.module as (specifier: string, options: MockModuleOptions) => void;
} else {
	const bunTest = (await import("bun:test")) as unknown as {
		mock: { module: (specifier: string, factory: () => Record<string, unknown>) => void };
	};

	mockModuleImpl = (specifier, options) => {
		bunTest.mock.module(specifier, () => {
			const moduleExports: Record<string, unknown> = {};
			if (options.defaultExport !== undefined) {
				moduleExports.default = options.defaultExport;
			}
			if (options.namedExports) {
				Object.assign(moduleExports, options.namedExports);
			}
			return moduleExports;
		});
	};
}

export const mock = { module: mockModuleImpl };
