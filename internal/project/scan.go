package project

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/security"
	"boss-job-assistant/internal/utils"
)

const (
	maxReadmeBytes     = 64 * 1024
	maxEvidenceFiles   = 20
	maxScannedFiles    = 800
	maxCoreModuleCount = 12
)

var ignoredDirectories = map[string]struct{}{
	".git":         {},
	".idea":        {},
	".vscode":      {},
	"node_modules": {},
	"vendor":       {},
	"dist":         {},
	"build":        {},
	"target":       {},
	"bin":          {},
	"obj":          {},
	".next":        {},
}

var techSignals = map[string][]string{
	"Go":           {"go.mod", ".go"},
	"Java":         {"pom.xml", "build.gradle", ".java"},
	"Node.js":      {"package.json", ".js", ".ts"},
	"React":        {"react", "vite", "next"},
	"Vue":          {"vue", "nuxt"},
	"Python":       {"requirements.txt", "pyproject.toml", ".py"},
	"Docker":       {"dockerfile", "docker-compose"},
	"Kubernetes":   {"deployment.yaml", "service.yaml", "k8s"},
	"MySQL":        {"mysql"},
	"Redis":        {"redis"},
	"Kafka":        {"kafka"},
	"MongoDB":      {"mongodb", "mongo"},
	"PostgreSQL":   {"postgres", "postgresql"},
	"Microservice": {"grpc", "microservice", "微服务"},
}

func ScanProjects(paths []string) ([]domain.ProjectSummary, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("至少需要选择一个项目目录")
	}
	if len(paths) > 20 {
		return nil, fmt.Errorf("单次最多扫描 20 个项目目录")
	}

	projectSummaries := make([]domain.ProjectSummary, 0, len(paths))
	for _, rawPath := range paths {
		projectSummary, scanErr := ScanProject(rawPath)
		if scanErr != nil {
			return nil, fmt.Errorf("扫描项目失败 %q: %w", rawPath, scanErr)
		}
		projectSummaries = append(projectSummaries, projectSummary)
	}

	return projectSummaries, nil
}

// 扫描项目：只读取用户指定目录，避免越权扫描本机文件。
func ScanProject(rawPath string) (domain.ProjectSummary, error) {
	absolutePath, validateErr := security.ValidateProjectPath(rawPath)
	if validateErr != nil {
		return domain.ProjectSummary{}, validateErr
	}

	projectID, idErr := utils.NewID("project")
	if idErr != nil {
		return domain.ProjectSummary{}, idErr
	}

	scanState := &projectScanState{
		rootPath:         absolutePath,
		techSignals:      make([]string, 0),
		evidenceFiles:    make([]string, 0),
		coreModules:      make([]string, 0),
		readmeSnippets:   make([]string, 0),
		scannedFileCount: 0,
	}

	walkErr := filepath.WalkDir(absolutePath, scanState.visitPath)
	if walkErr != nil {
		return domain.ProjectSummary{}, fmt.Errorf("遍历项目目录失败: %w", walkErr)
	}

	techStack := detectTechStack(scanState.techSignals, strings.Join(scanState.readmeSnippets, " "))
	coreModules := utils.UniqueNonEmpty(scanState.coreModules)
	if len(coreModules) > maxCoreModuleCount {
		coreModules = coreModules[:maxCoreModuleCount]
	}

	return domain.ProjectSummary{
		ID:             projectID,
		Name:           filepath.Base(absolutePath),
		Path:           absolutePath,
		TechStack:      techStack,
		BusinessDomain: inferBusinessDomain(strings.Join(scanState.readmeSnippets, " ")),
		CoreModules:    coreModules,
		Highlights:     buildHighlights(techStack, coreModules),
		EvidenceFiles:  utils.UniqueNonEmpty(scanState.evidenceFiles),
		FileCount:      scanState.scannedFileCount,
		ScannedAt:      time.Now(),
	}, nil
}

type projectScanState struct {
	rootPath         string
	techSignals      []string
	evidenceFiles    []string
	coreModules      []string
	readmeSnippets   []string
	scannedFileCount int
}

func (state *projectScanState) visitPath(path string, directoryEntry fs.DirEntry, entryErr error) error {
	if entryErr != nil {
		return nil
	}

	entryName := directoryEntry.Name()
	if directoryEntry.IsDir() {
		if shouldIgnoreDirectory(entryName) && path != state.rootPath {
			return filepath.SkipDir
		}
		if path != state.rootPath && len(state.coreModules) < maxCoreModuleCount {
			state.coreModules = append(state.coreModules, entryName)
		}
		return nil
	}

	if state.scannedFileCount >= maxScannedFiles {
		return filepath.SkipAll
	}
	state.scannedFileCount++

	relativePath, relativeErr := filepath.Rel(state.rootPath, path)
	if relativeErr == nil && len(state.evidenceFiles) < maxEvidenceFiles {
		state.evidenceFiles = append(state.evidenceFiles, relativePath)
	}

	lowerName := strings.ToLower(entryName)
	state.techSignals = append(state.techSignals, lowerName)
	if isReadmeFile(lowerName) {
		state.readReadmeSnippet(path)
	}

	return nil
}

func (state *projectScanState) readReadmeSnippet(path string) {
	file, openErr := os.Open(path)
	if openErr != nil {
		return
	}
	defer file.Close()

	buffer := make([]byte, maxReadmeBytes)
	readSize, readErr := file.Read(buffer)
	if readErr != nil && readSize == 0 {
		return
	}

	state.readmeSnippets = append(state.readmeSnippets, string(buffer[:readSize]))
}

func shouldIgnoreDirectory(directoryName string) bool {
	_, ignored := ignoredDirectories[strings.ToLower(directoryName)]
	return ignored
}

func isReadmeFile(fileName string) bool {
	return strings.HasPrefix(fileName, "readme")
}

func detectTechStack(signals []string, readmeText string) []string {
	joinedSignals := strings.ToLower(strings.Join(signals, " ") + " " + readmeText)
	detectedTechStack := make([]string, 0)
	for techName, signalValues := range techSignals {
		if utils.ContainsAnyFold(joinedSignals, signalValues) {
			detectedTechStack = append(detectedTechStack, techName)
		}
	}

	return utils.UniqueNonEmpty(detectedTechStack)
}

func inferBusinessDomain(readmeText string) string {
	lowerText := strings.ToLower(readmeText)
	switch {
	case utils.ContainsAnyFold(lowerText, []string{"job", "招聘", "简历", "boss"}):
		return "招聘求职"
	case utils.ContainsAnyFold(lowerText, []string{"payment", "订单", "支付", "交易"}):
		return "交易支付"
	case utils.ContainsAnyFold(lowerText, []string{"crm", "客户", "销售"}):
		return "CRM"
	case utils.ContainsAnyFold(lowerText, []string{"ai", "llm", "deepseek", "openai"}):
		return "AI 应用"
	default:
		return "待用户确认"
	}
}

func buildHighlights(techStack []string, coreModules []string) []string {
	highlights := make([]string, 0)
	if len(techStack) > 0 {
		highlights = append(highlights, "基于现有项目证据识别技术栈："+strings.Join(techStack, "、"))
	}
	if len(coreModules) > 0 {
		highlights = append(highlights, "项目包含可拆解模块："+strings.Join(coreModules, "、"))
	}
	highlights = append(highlights, "后续简历改写只基于扫描证据和用户确认信息，不自动编造结果指标")
	return highlights
}
