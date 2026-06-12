export function fixtureComplete() {
  let turn = 0;
  return async () => ({
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls:
            turn++ === 0
              ? [tc("list_fields", {})]
              : [
                  tc("set_field", { name: "full_name", value: "Jane A. Doe" }),
                  tc("set_field", { name: "date_of_birth", value: "1990-04-12" }),
                  tc("set_field", { name: "city", value: "Memphis" }),
                  tc("set_field", { name: "state", value: "TN" }),
                  tc("set_field", { name: "email", value: "jane.doe@example.com" }),
                  tc("set_field", { name: "us_citizen", value: true }),
                  tc("set_field", { name: "purpose", value: "Business" }),
                  tc("finish", { summary: "Offline mock filled the fixture form." }),
                ],
        },
      },
    ],
  });
}

function tc(name: string, args: Record<string, unknown>) {
  return {
    id: `call_${name}_${Math.random().toString(16).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
