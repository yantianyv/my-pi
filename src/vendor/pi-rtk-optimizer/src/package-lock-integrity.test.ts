import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runTest } from "./test-helpers.test.ts";

type PackageLockPackage = {
	version?: unknown;
	bin?: Record<string, unknown>;
};

type PackageLock = {
	packages?: Record<string, PackageLockPackage>;
};

const packageLockPath = fileURLToPath(new URL("../package-lock.json", import.meta.url));

function loadPackageLock(): PackageLock {
	return JSON.parse(readFileSync(packageLockPath, "utf-8")) as PackageLock;
}

function packageEntries(): Array<[string, PackageLockPackage]> {
	return Object.entries(loadPackageLock().packages ?? {});
}

runTest("package-lock is install-safe and npm-idempotent", () => {
	const entries = packageEntries();
	const missingVersions = entries
		.filter(([packagePath, metadata]) => packagePath !== "" && typeof metadata.version !== "string")
		.map(([packagePath]) => packagePath);
	const unnormalizedBinPaths = entries.flatMap(([packagePath, metadata]) =>
		Object.entries(metadata.bin ?? {})
			.filter(([, binPath]) => typeof binPath === "string" && binPath.startsWith("./"))
			.map(([binName, binPath]) => `${packagePath}:${binName}=${binPath}`),
	);

	assert.deepEqual(
		{ missingVersions, unnormalizedBinPaths },
		{ missingVersions: [], unnormalizedBinPaths: [] },
		[
			"package-lock.json must be safe for npm install --omit=dev and stay unchanged after install.",
			"Missing versions reproduce npm's Invalid Version failure.",
			"Leading ./ bin paths reproduce npm lockfile normalization diffs after install.",
		].join(" "),
	);
});

console.log("All package-lock integrity tests passed.");
