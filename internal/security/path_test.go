package security

import "testing"

func TestValidateProjectPathRejectsEmpty(t *testing.T) {
	if _, validateErr := ValidateProjectPath(""); validateErr == nil {
		t.Fatalf("空路径必须返回错误")
	}
}
