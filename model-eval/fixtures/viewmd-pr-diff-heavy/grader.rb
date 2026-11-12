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
flat = answer.values.map { |value| value.to_s }.join(" ").downcase
prose = raw.downcase

checks = []
checks << {"name" => "names the check box module", "required" => true,
           "passed" => flat.include?("check-box") || flat.include?("check_box") || flat.include?("checkbox")}
checks << {"name" => "names the refusal function", "required" => true,
           "passed" => flat.include?("boxrefusal") || flat.include?("box_refusal")}
checks << {"name" => "names check_authors storage", "required" => true,
           "passed" => flat.include?("check_authors")}
checks << {"name" => "names a deliberately omitted item", "required" => true,
           "passed" => %w[203 ownership swept sweep "escape hatch" guard-05].any? { |word| flat.include?(word) } }
checks << {"name" => "answers as JSON", "required" => true, "passed" => !answer.empty?}
checks << {"name" => "does not dump the patch", "required" => false, "passed" => prose.length < 20_000}

puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
