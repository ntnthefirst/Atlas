"use strict";

// ---------------------------------------------------------------------------
// The bridge between MCP tools and the AI layer (WP-4.3): turning connected
// servers' tools into the canonical spec a provider understands, and executing
// the calls a model asks for.
//
// -- One round, deliberately -------------------------------------------------
// This executes the tool calls in ONE model response and returns their
// results. It does not feed them back for a second round, because the provider
// contract takes a single `prompt` rather than a conversation, and a
// multi-turn tool loop needs message history the contract cannot yet carry.
//
// That history is WP-4.5's problem, and belongs there: "the vision's example
// prompts work end to end" is precisely the criterion that requires it. Faking
// it here -- by concatenating results into a new prompt string -- would look
// like it worked and would quietly lose the structure every provider needs to
// attribute a result to the call it answers.
//
// So WP-4.3's criterion ("tools discovered and invocable through the AI
// layer") is met exactly: discovered, offered, called, results returned.
//
// -- Nothing here decides whether a call is ALLOWED --------------------------
// Every call handed to `executeToolCalls` is executed. That is correct for
// WP-4.3, where the only servers reachable are ones the user configured in the
// active environment -- but it is not a permission model, and WP-4.4 is what
// adds one. When it does, the check belongs in front of this function, not
// inside it: a runner that sometimes refuses would make "was this call
// allowed" a question with two answers depending on which path asked.
// ---------------------------------------------------------------------------

// A model can ask for many calls at once, and a runaway one can ask for a
// great many. Bounded so a single response cannot occupy the app indefinitely.
const MAX_CALLS_PER_RESPONSE = 16;

/**
 * Every connected server's tools, in the canonical spec shape
 * (./contract.cjs#normalizeToolSpec's input). Names are already qualified by
 * server id, so a model's answer is unambiguous about which server it meant.
 */
function buildToolSpecs(manager) {
	if (!manager) {
		return [];
	}
	return manager.listTools().map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

/**
 * Runs the calls a model asked for, in order, and returns one result per call.
 *
 * Sequential rather than parallel on purpose: tools have side effects, a model
 * that asks to create something and then read it back expects that order, and
 * running them concurrently would make the outcome depend on timing.
 *
 * A call that fails becomes a result carrying the error, never a throw -- the
 * model is supposed to see that a tool failed, and one bad call must not
 * discard the results of the good ones beside it.
 */
async function executeToolCalls(manager, toolCalls, options = {}) {
	const calls = Array.isArray(toolCalls) ? toolCalls.slice(0, options.maxCalls ?? MAX_CALLS_PER_RESPONSE) : [];
	const results = [];

	for (const call of calls) {
		if (!call || typeof call.name !== "string") {
			continue;
		}
		// A model that produced unparsable arguments is refused rather than
		// invoked with `{}` -- calling a tool with arguments the model did not
		// actually mean is worse than not calling it.
		if (call.malformedArguments) {
			results.push({
				id: call.id,
				name: call.name,
				ok: false,
				isError: true,
				text: "",
				error: "The model sent arguments that could not be read.",
			});
			continue;
		}
		if (!manager) {
			results.push({ id: call.id, name: call.name, ok: false, isError: true, text: "", error: "No tools are available." });
			continue;
		}

		const outcome = await manager.callTool(call.name, call.arguments ?? {});
		results.push({
			id: call.id,
			name: call.name,
			ok: Boolean(outcome.ok),
			// A tool that ran and reported failure is a normal outcome; a call
			// that could not be made at all is not. Both are surfaced, kept
			// apart, and neither throws.
			isError: Boolean(outcome.isError) || !outcome.ok,
			text: typeof outcome.text === "string" ? outcome.text : "",
			error: outcome.ok ? null : (outcome.error ?? "The tool call failed."),
		});
	}

	return results;
}

/** How many calls were dropped for exceeding the cap, so a caller can say so. */
function countDroppedCalls(toolCalls, options = {}) {
	const max = options.maxCalls ?? MAX_CALLS_PER_RESPONSE;
	const total = Array.isArray(toolCalls) ? toolCalls.length : 0;
	return Math.max(0, total - max);
}

module.exports = { MAX_CALLS_PER_RESPONSE, buildToolSpecs, executeToolCalls, countDroppedCalls };
