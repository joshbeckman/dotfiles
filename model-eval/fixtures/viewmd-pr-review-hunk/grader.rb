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
first = answer["first_ask"].to_s.downcase
second = answer["second_ask"].to_s.downcase

checks = []
checks << {"name" => "path is pana/prompt.md", "required" => true, "passed" => path.include?("prompt.md")}
checks << {"name" => "first ask is thread participant, not the user", "required" => true,
           "passed" => first.match?(/participant/) && first.match?(/thread/) &&
                       first.match?(/not (?:the )?user|n.t the user|rather than the user|instead of the user|user doesn.t|user does not/) }
checks << {"name" => "second ask drops the output description", "required" => true,
           "passed" => second.match?(/output/) && second.match?(/help|drop|remove|tighten|don.t (?:have to )?tell|does not have to tell/) }
checks << {"name" => "answers as JSON", "required" => true, "passed" => !answer.empty?}

puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
