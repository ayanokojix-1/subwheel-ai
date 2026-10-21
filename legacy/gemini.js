// To run this code you need to install the following dependencies:
// npm install @google/genai
require("dotenv").config()
const { GoogleGenAI, Type } = require('@google/genai');

async function main() {
  const ai = new GoogleGenAI({
    apiKey: process.env['GEMINI_API_KEY'],
  });

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'list_data_plans',
          description: 'Lists all available data plans for a given mobile network, sorted cheapest first.',
          parameters: {
            type: Type.OBJECT,
            required: ['network'],
            properties: {
              network: {
                type: Type.STRING,
                enum: ['mtn', 'glo', 'airtel', '9mobile'],
              },
            },
          },
        },
        {
          name: 'buy_data',
          description:
            "Purchases a data plan for a customer's phone number. Only call this after the customer has confirmed the network, plan, price, and phone number.",
          parameters: {
            type: Type.OBJECT,
            required: ['network', 'planID', 'phone'],
            properties: {
              network: {
                type: Type.STRING,
                enum: ['mtn', 'glo', 'airtel', '9mobile'],
              },
              planID: {
                type: Type.INTEGER,
                description: 'The plan ID from list_data_plans for the chosen plan',
              },
              phone: {
                type: Type.STRING,
                description: "Customer's phone number, no country code (e.g. 08012345678)",
              },
            },
          },
        },
      ],
    },
  ];

  const config = {
    tools,
    responseMimeType: 'text/plain',
    systemInstruction: [
      {
        text: `You are a data/airtime sales assistant for subwheel ai data services. You sell
mobile data plans for MTN, Glo, Airtel, and 9mobile.

Rules:
- Always confirm the network and plan the customer wants before buying data. Even when the customer wants it twice.
- Prices you get back are final customer prices — quote them exactly, don't do your own math.
- Before buying, always confirm: network, plan, price, and the phone number
  the data should be sent to. Read it back to the customer for confirmation.
- Never guess a phone number. If unclear, ask.
- Keep responses short — this is a chat interface, not an essay.
- If a tool call fails or returns no plans, tell the customer plainly and
  suggest trying again shortly. Don't make up plans.
- Make sure to confirm that the user input the right details before making the transaction
When presenting a list of data plans:
- Group them by type (SME, Gifting, Corporate) with a short header for each group.
- Within each group, sort by size (smallest to largest).
- Format each line as: size — duration — ₦price (nothing extra, no plan IDs shown to the customer).
- Skip near-duplicate plans (same size, same duration, negligible price difference) — show only the cheaper one.
- After the list, ask which one they want in plain language (e.g. "which one?"), not by asking for an ID.
- Never call list_data_plans until the customer has told you which network
  (MTN, Glo, Airtel, 9mobile) they want. If they don't mention it, ask first —
  do not guess or search across networks to find a price match.
- If the customer's phrasing is ambiguous (e.g. unclear if they want multiple
  units), ask them to clarify exactly what they mean before proceeding.`,
      },
    ],
  };

  const model = 'gemini-3.1-flash-lite';

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: 'What are the things you can do? Can u help me check available airtel plans?  Yes, pull up the list for both glo and airtel',
        },
      ],
    },
  ];

  const response = await ai.models.generateContentStream({
    model,
    config,
    contents,
  });

  for await (const chunk of response) {
    if (chunk.functionCalls) {
      console.log(chunk.functionCalls[0]);
    } else if (chunk.text) {
      console.log(chunk.text);
    }
  }
}

main();