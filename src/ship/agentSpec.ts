// The ElevenLabs Conversational AI agent that answers "what leads to…?" out loud.
// One source for both sides: scripts/eleven-agent.ts creates the agent and its
// client tools from this, and src/ship/agent.ts registers handlers under the same
// tool names (they are case-sensitive and must match).

export const AGENT_NAME = '2SOON2026 Oracle of futures';
export const AGENT_LLM = 'gemini-2.5-flash';
export const AGENT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';    // "George", the ship's stock voice
export const AGENT_TTS_MODEL = 'eleven_flash_v2_5';

export const AGENT_FIRST_MESSAGE =
  "The futures are open. Name a moment: the colonisation of Mars, a terraformed Venus, the first Dyson swarm. I'll show you the roads that lead there.";

export const AGENT_PROMPT = `You are the Oracle of 2SOON2026, a voice guide to a simulation of humanity spreading through space, from the first Mars landing in 2040 to the year 12040. Each "future" is one full run of the simulation with different dice, known by its future number.

When the user names a moment they want to reach, such as the colonisation of Mars, terraforming Venus, the first Dyson swarm, mind uploading, first contact, a city on Titan, a trillion people, or a Kardashev Type II civilisation, call find_futures with that goal in a few plain words. Never invent dates, places or events: every year, place and event you mention must come from a find_futures result.

The result lists the futures that reached the goal, each with the year it happened and the steps that led there, and says how many futures never reached it. Answer briefly, in speech: say how many futures reached it and the range of years, then walk through two or three contrasting futures (the earliest, the latest, and one that took an unusual road), naming the two or three steps that made the difference in each. Keep a reply under about 90 words unless the user asks for more. Say years the way people say them aloud ("twenty-three eighty-eight").

If the user wants to see a future, or one step in it, call watch_future with its future number, and a calendar year if they named a step. The screen flies there and plays the simulation. If find_futures could not understand the goal, ask the user to rephrase and offer two or three example goals. If no future reached the goal, say so plainly, and say how close they came if the result tells you.

Stay with this simulation. If asked about anything else, answer in one sentence at most and steer back to the futures.`;

/** Client tool configs, in the shape POST /v1/convai/tools expects as `tool_config`. */
export const AGENT_TOOLS = [
  {
    type: 'client',
    name: 'find_futures',
    description: 'Simulate several futures and find the ones that reach a moment in the timeline. Returns, for each future that got there, the year and the steps that led to it, plus how many futures never did. Call it whenever the user names a milestone they want to reach.',
    expects_response: true,
    response_timeout_secs: 120,
    pre_tool_speech: 'force',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: "The moment to reach, in a few plain words: 'colonisation of Mars', 'terraforming Venus', 'first Dyson swarm', 'Dyson swarm phase II', 'mind uploading', 'first contact', 'city on Titan', 'colony at Tau Ceti', 'a trillion people', 'Kardashev 2', 'warp drive'.",
        },
      },
      required: ['goal'],
    },
  },
  {
    type: 'client',
    name: 'watch_future',
    description: 'Switch the screen to one of the futures returned by find_futures and play its simulation up to the goal, or jump to one step of it.',
    expects_response: true,
    response_timeout_secs: 20,
    parameters: {
      type: 'object',
      properties: {
        future: { type: 'integer', description: 'The future number, as given by find_futures.' },
        year: { type: 'integer', description: 'Optional calendar year of a step to jump to, e.g. 2188. Leave out to watch the run-up to the goal.' },
      },
      required: ['future'],
    },
  },
] as const;

export type AgentToolName = typeof AGENT_TOOLS[number]['name'];
