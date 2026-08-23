import { assertEquals } from "@std/assert";
import { name } from "../src/page-fetcher.ts";

Deno.test("sanity check", () => {
	assertEquals(name(), "it works");
});
