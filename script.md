Analyze the conversation above using the SCRIPT framework to determine if it can be extracted into an executable script.

For each criterion, provide a score (0-2) and brief justification:

**S**tructured Tool Usage (0-2):
- 0: No tool calls or only general conversation
- 1: Some tool calls mixed with reasoning
- 2: Primarily tool calls with clear parameters

**C**onsistent Flow (0-2):
- 0: Many dead ends, backtracking, or exploration
- 1: Some detours but overall forward progress
- 2: Linear sequence of operations

**R**epeatable Intent (0-2):
- 0: Exploratory or creative task
- 1: Semi-structured task with some variation
- 2: Clear, definable objective

**I**solated Context (0-2):
- 0: Heavily dependent on conversation history
- 1: Some external context needed
- 2: Self-contained with clear inputs

**P**redictable Outputs (0-2):
- 0: Highly variable or creative outputs
- 1: Semi-structured outputs
- 2: Consistent, structured results

**T**erminal State (0-2):
- 0: Open-ended conversation
- 1: Vague completion criteria
- 2: Clear end goal achieved

Provide:
1. Individual scores with justification
2. Total score (0-12)
3. Recommendation: HIGHLY EXTRACTABLE (10-12), EXTRACTABLE (7-9), DIFFICULT (4-6), or NOT RECOMMENDED (0-3)
4. If extractable, list the main operations that would form the script

---

Extract the workflow from the conversation above into an executable script in [LANGUAGE].

Requirements:
1. Include only essential tool calls and data transformations
2. Use pipe operators or method chaining where appropriate
3. Parameterize inputs that could vary (e.g., search queries, dates)
4. Add minimal comments only for complex operations
5. Structure the code as a reusable function or script
6. Handle errors gracefully with appropriate defaults

Format:
- Start with input parameters
- Show the data flow clearly
- End with the output/return value

For [LANGUAGE], follow these conventions:
- Python: Use function composition or method chaining
- JavaScript: Use promise chains or pipe functions
- Bash: Use Unix pipes
- Ruby: Use method chaining

The script should be runnable and produce the same effective result as our conversation.

Example structure:
```[LANGUAGE]
# Extracted from: [brief description of original task]
# Parameters: [list key inputs]

def workflow_name(param1, param2):
    result = (
        tool_call_1(param1)
        |> transform_operation()
        |> tool_call_2(param2)
        |> final_processing()
    )
    return result
```

---

## Usage Tips

1. **For the assessment prompt**: Run this first to verify the conversation is worth extracting. If it scores < 7, you might want to refactor the conversation before extraction.

2. **For the extraction prompt**: Replace `[LANGUAGE]` with your target language. You might want language-specific variants:
   - For Python: "Use pandas pipes or toolz library for functional composition"
   - For JavaScript: "Use Ramda or lodash/fp for pipe operations"
   - For Bash: "Use jq for JSON processing where appropriate"

3. **Iteration approach**: You could also add a third prompt for refinement:

---

Analyze this conversation using the SCRIPT framework and extract it
into an executable script if suitable:

[PASTE CONVERSATION HERE]

Steps:
1. Evaluate extractability using SCRIPT framework (provide scores 0-2
 for each criterion)
2. If score ≥7, create a script named `[SCRIPT_NAME]` that:
   - Uses the simplest appropriate language (bash/python/etc)
   - Accepts relevant parameters as command-line arguments
   - Replicates the core workflow from the conversation
   - Includes basic error handling
3. Make the script executable and test it
4. Fix any issues found during testing
5. Provide usage instructions

Focus on the essential operations that achieved the main objective,
not exploratory or conversational elements.
