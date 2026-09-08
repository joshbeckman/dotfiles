require "json"

workspace = ARGV.fetch(0)
text = File.read(File.join(workspace, "note.md"))
plain = text.downcase
checks = [
  {"name" => "under 90 words", "required" => true, "passed" => text.split.length <= 90},
  {"name" => "removes indirect opening", "required" => true, "passed" => !plain.match?(/wanted to provide|there was a situation|we have now made/)},
  {"name" => "preserves retry count", "required" => true, "passed" => plain.match?(/two|2/) && plain.include?("temporar")},
  {"name" => "preserves September 3 scope", "required" => true, "passed" => plain.include?("september 3") && plain.include?("created after")},
  {"name" => "preserves permanent error behavior", "required" => true, "passed" => plain.include?("permanent") && plain.include?("immediately")},
  {"name" => "preserves existing failure behavior", "required" => true, "passed" => plain.include?("existing") && plain.match?(/not restart|aren.t restart|won.t restart/)},
  {"name" => "ends with useful next step", "required" => true, "passed" => plain.include?("error report") && plain.include?("export id") && plain.include?("contact support")},
  {"name" => "no heading", "required" => false, "passed" => !text.lines.any? { |line| line.start_with?("#") }},
  {"name" => "no unsupported guarantee", "required" => true, "passed" => !plain.match?(/always succeed|never fail|guarantee/)}
]
puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
