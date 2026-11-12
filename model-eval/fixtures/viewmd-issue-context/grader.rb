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
finding = answer["finding"].to_s.downcase
pairs = answer["pairs"].to_s.downcase
limit = answer["limit"].to_s.downcase

checks = []
checks << {"name" => "finding is no consistent token reduction", "required" => true,
           "passed" => finding.match?(/no (?:consistent|clear|general)|did not (?:show|find|reduce)|not enough|not consistent/) &&
                       finding.match?(/token/) }
checks << {"name" => "three sequential pairs", "required" => true, "passed" => pairs.match?(/\b3\b|three/)}
checks << {"name" => "names a stated limit", "required" => true,
           "passed" => %w[one model synthetic cache pair sample provider load].count { |word| limit.include?(word) } >= 1}
checks << {"name" => "answers as JSON", "required" => true, "passed" => !answer.empty?}

puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
