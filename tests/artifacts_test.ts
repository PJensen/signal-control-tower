import { extractArtifactDeclarations, validateArtifactPaths } from "../src/artifacts.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function assertRejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if ((error as Error).message.includes(message)) return;
    throw error;
  }
  throw new Error(`Expected rejection containing: ${message}`);
}

Deno.test("outbound artifacts are extracted and constrained to the workspace", async () => {
  assertEquals(extractArtifactDeclarations("Done.\nATTACHMENT: `reports/result.txt`"), {
    summary: "Done.",
    paths: ["reports/result.txt"],
  });

  const root = await Deno.makeTempDir({ prefix: "signal-artifacts-" });
  try {
    const workspace = `${root}/project`;
    await Deno.mkdir(`${workspace}/reports`, { recursive: true });
    await Deno.writeTextFile(`${workspace}/reports/result.txt`, "result\n");
    assertEquals(await validateArtifactPaths(workspace, ["reports/result.txt"]), [
      `${workspace}/reports/result.txt`,
    ]);

    await Deno.writeTextFile(`${root}/outside.txt`, "private\n");
    await Deno.symlink(`${root}/outside.txt`, `${workspace}/outside.txt`);
    await assertRejects(
      () => validateArtifactPaths(workspace, ["outside.txt"]),
      "escapes the project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
