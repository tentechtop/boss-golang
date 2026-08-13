package utils

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

func NewID(prefix string) (string, error) {
	var randomBytes [8]byte
	if _, readErr := rand.Read(randomBytes[:]); readErr != nil {
		return "", fmt.Errorf("生成随机编号失败: %w", readErr)
	}

	cleanPrefix := strings.TrimSpace(prefix)
	if cleanPrefix == "" {
		cleanPrefix = "id"
	}

	return fmt.Sprintf("%s_%d_%s", cleanPrefix, time.Now().UnixMilli(), hex.EncodeToString(randomBytes[:])), nil
}
