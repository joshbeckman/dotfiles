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
verdict = answer["verdict"].to_s.downcase
head = answer["head"].to_s.downcase
s1 = answer["s1"].to_s.downcase
s2 = answer["s2"].to_s.downcase

checks = []
checks << {"name" => "latest verdict is approve with nits", "required" => true,
           "passed" => verdict.include?("approve") && (verdict.include?("nit") || verdict.include?("comment"))}
checks << {"name" => "names head 06dcd2e", "required" => true, "passed" => head.include?("06dcd2e")}
checks << {"name" => "S1 is store writes by any same-user process", "required" => true,
           "passed" => s1.match?(/(?:any|every|same-user|session).{0,60}(?:process|caller|user)/) &&
                       s1.match?(/secret|store|socket|write/) }
checks << {"name" => "S2 is browser password manager copy", "required" => true,
           "passed" => s2.match?(/autocomplete|password manager|keychain|autofill|save password/)}
checks << {"name" => "answers as JSON", "required" => true, "passed" => !answer.empty?}

puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
