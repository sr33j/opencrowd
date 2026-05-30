here is a list of my thoughts

opencrowd should be an LLM loop
this loop optionally you can log into your claude code or codex subscription, like how other agents do it
you can also optionally load in an anthropic or openai key
lets copy how mono-pi does this

if you dont provide either of these, its what we have currently have

forget ows, its just a base wallet attached to an agent

and lets forget everything about a budget limit and permissions, lets just keep track of the ledger, well dont forget it, but those should be optional. by default, the budget is the amount in the wallet, and all services have permissions. 

and then we should have a system prompt that explains what is happening
- there is a wallet attached the agent, this is all the agent has is USDC on base and file/bash tools. it is running locally.
- you must try your best to solve the task completely
- if file/bash tools are not enough to solve your problem, search for x402 services and use them
- use services as needed to solve your problems. you may need to test/try out multiple services, or use multiple services in sequence to solve your problem

the cli sessions should persist all past conversations for follow ups
it should know the context limit of each possible model it will use
it should compact the context (summarize it) when it's halfway through its context and before compacting, save the original to a context folder, and append that filename to the context

the agent should append tool calls and tooloutputs, before each tool call, it should append the budget remaining

try to make it as agentic as the mono-pi agent: https://github.com/earendil-works/pi . it should be an agent loop, can use file/bash tools well/write python, compact context, etc.

make sure the system prompt knows the tools and how it should solve problems. its given only a crypto wallet, and can spend base USDC on services to solve tasks

and by default, we should be in yolo mode

