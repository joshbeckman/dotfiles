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
path = answer["path"].to_s.downcase
pull_request = answer["pull_request"].to_s
closed_on = answer["closed_on"].to_s

checks = []
checks << {"name" => "names bin/free-space", "required" => true, "passed" => path.include?("free-space")}
checks << {"name" => "names the addressing pull request", "required" => true,
           "passed" => pull_request.match?(/(?<!\\d)239(?!\\d)/)}
checks << {"name" => "names the close date", "required" => true,
           "passed" => closed_on.include?("2026-11-07")}
checks << {"name" => "answers as JSON", "required" => true, "passed" => !answer.empty?}

puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
