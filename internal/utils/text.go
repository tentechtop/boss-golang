package utils

import (
	"regexp"
	"sort"
	"strings"
)

var multiSpacePattern = regexp.MustCompile(`\s+`)

func CleanText(value string, maxLength int) string {
	cleanedValue := strings.TrimSpace(multiSpacePattern.ReplaceAllString(value, " "))
	if maxLength <= 0 || len([]rune(cleanedValue)) <= maxLength {
		return cleanedValue
	}

	runes := []rune(cleanedValue)
	return string(runes[:maxLength])
}

func UniqueNonEmpty(values []string) []string {
	seenValues := make(map[string]struct{}, len(values))
	uniqueValues := make([]string, 0, len(values))

	for _, value := range values {
		cleanedValue := strings.TrimSpace(value)
		if cleanedValue == "" {
			continue
		}
		normalizedValue := strings.ToLower(cleanedValue)
		if _, exists := seenValues[normalizedValue]; exists {
			continue
		}
		seenValues[normalizedValue] = struct{}{}
		uniqueValues = append(uniqueValues, cleanedValue)
	}

	sort.Strings(uniqueValues)
	return uniqueValues
}

func ContainsAnyFold(text string, keywords []string) bool {
	lowerText := strings.ToLower(text)
	for _, keyword := range keywords {
		if strings.Contains(lowerText, strings.ToLower(keyword)) {
			return true
		}
	}
	return false
}

func IntersectFold(leftValues []string, rightValues []string) []string {
	rightSet := make(map[string]string, len(rightValues))
	for _, value := range rightValues {
		cleanedValue := strings.TrimSpace(value)
		if cleanedValue == "" {
			continue
		}
		rightSet[strings.ToLower(cleanedValue)] = cleanedValue
	}

	matches := make([]string, 0)
	for _, value := range leftValues {
		cleanedValue := strings.TrimSpace(value)
		if cleanedValue == "" {
			continue
		}
		if matchedValue, exists := rightSet[strings.ToLower(cleanedValue)]; exists {
			matches = append(matches, matchedValue)
		}
	}

	return UniqueNonEmpty(matches)
}
