require "json"

workspace, answer_path = ARGV

def answer_json(text)
  text.each_line do |line|
    candidate = line.strip.sub(/\A```(?:json)?/, "").sub(/```\z/, "").strip
    next unless candidate.start_with?("{") && candidate.end_with?("}")
    begin
      return JSON.parse(candidate)
    rescue JSON::ParserError
      next
    end
  end
  {}
end

raw = File.file?(answer_path) ? File.read(answer_path) : ""
answer = answer_json(raw)
files = Array(answer["files"]).join(" ").downcase
first = answer["first_choice"].to_s.downcase
fallback = answer["fallback_reason"].to_s.downcase

checks = []
checks << {"name" => "names bin/git-pr-lookup", "required" => true, "passed" => files.include?("git-pr-lookup") || files.include?("git-pr-view")}
checks << {"name" => "names the pr-lookup test", "required" => true, "passed" => files.include?("test/pr-lookup") || files.include?("pr-lookup test")}
checks << {"name" => "first choice is gh view-md", "required" => true, "passed" => first.include?("view-md") || first.include?("view_md")}
checks << {"name" => "fallback reason is a machine without the extension", "required" => true,
           "passed" => fallback.match?(/extension|installed|missing|not have|without/) &&
                       fallback.match?(/fail|break|fallback|gh pr view|read/) }
checks << {"name" => "answers as JSON", "required" => true, "passed" => !answer.empty?}

puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
