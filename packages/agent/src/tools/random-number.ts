import { defineTool } from "@github/copilot-sdk";

export const randomNumberTool = defineTool("random_number", {
  description: "Returns a random integer between min and max (inclusive).",
  parameters: {
    type: "object",
    properties: {
      min: { type: "number", description: "Minimum value (inclusive)" },
      max: { type: "number", description: "Maximum value (inclusive)" },
    },
    required: ["min", "max"],
  },
  handler: (args: { min: number; max: number }) => {
    const lo = Math.ceil(args.min);
    const hi = Math.floor(args.max);
    const value = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    return { value };
  },
  skipPermission: true,
});
