package api

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/resume"
	"boss-job-assistant/internal/utils"
)

const (
	multipartMemoryThresholdBytes = 32 << 20
)

type importResumeRequest struct {
	ResumeText string                  `json:"resumeText"`
	Profile    domain.CandidateProfile `json:"profile"`
}

// 导入简历：接收用户粘贴的原始简历文本；实现原因：无障碍一键求职不能依赖项目扫描后再生成简历。
func (server *Server) handleImportResume(responseWriter http.ResponseWriter, request *http.Request) {
	var payload importResumeRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	server.saveImportedResume(responseWriter, "", payload.ResumeText, payload.Profile)
}

// 文件导入简历：接收单个文本或 DOCX 文件；实现原因：用户不应被迫手动复制整份简历。
func (server *Server) handleImportResumeFile(responseWriter http.ResponseWriter, request *http.Request) {
	if parseErr := request.ParseMultipartForm(multipartMemoryThresholdBytes); parseErr != nil {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("解析简历文件失败: %w", parseErr))
		return
	}
	if request.MultipartForm != nil {
		defer func() {
			if cleanupErr := request.MultipartForm.RemoveAll(); cleanupErr != nil && server.logger != nil {
				server.logger.Error("清理简历上传临时文件失败", "error", cleanupErr)
			}
		}()
	}

	uploadedFile, fileHeader, fileErr := request.FormFile("resumeFile")
	if fileErr != nil {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("请选择一份简历文件: %w", fileErr))
		return
	}
	defer func() {
		if closeErr := uploadedFile.Close(); closeErr != nil && server.logger != nil {
			server.logger.Error("关闭简历上传文件失败", "fileName", filepath.Base(fileHeader.Filename), "error", closeErr)
		}
	}()

	fileContent, readErr := io.ReadAll(uploadedFile)
	if readErr != nil {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("读取简历文件失败: %w", readErr))
		return
	}
	sourceFileName := filepath.Base(fileHeader.Filename)
	resumeText, extractErr := extractResumeText(sourceFileName, fileContent)
	if extractErr != nil {
		writeError(responseWriter, http.StatusBadRequest, extractErr)
		return
	}

	profile := domain.CandidateProfile{
		TargetRole: request.FormValue("targetRole"),
		Location:   request.FormValue("location"),
	}
	server.saveImportedResume(responseWriter, sourceFileName, resumeText, profile)
}

func (server *Server) saveImportedResume(responseWriter http.ResponseWriter, sourceFileName string, resumeText string, profile domain.CandidateProfile) {
	if strings.TrimSpace(resumeText) == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("简历内容不能为空"))
		return
	}

	cleanedProfile := sanitizeImportedProfile(profile)
	resumeVersion, importErr := resume.ImportFromText(resumeText, cleanedProfile)
	if importErr != nil {
		writeError(responseWriter, http.StatusBadRequest, importErr)
		return
	}
	resumeVersion.SourceFileName = utils.CleanText(filepath.Base(sourceFileName), 200)

	if saveErr := server.store.SaveResume(resumeVersion); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, fmt.Errorf("保存导入简历失败: %w", saveErr))
		return
	}

	if server.logger != nil {
		server.logger.Info(
			"导入简历完成",
			"resumeID", resumeVersion.ID,
			"targetRole", resumeVersion.Profile.TargetRole,
			"location", resumeVersion.Profile.Location,
		)
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{"resume": resumeVersion})
}

func extractResumeText(fileName string, fileContent []byte) (string, error) {
	if len(fileContent) == 0 {
		return "", fmt.Errorf("简历文件不能为空")
	}
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".txt", ".md":
		if !utf8.Valid(fileContent) {
			return "", fmt.Errorf("简历文本必须使用 UTF-8 编码")
		}
		return normalizeExtractedResumeText(strings.TrimPrefix(string(fileContent), "\ufeff"))
	case ".docx":
		return extractDOCXResumeText(fileContent)
	default:
		return "", fmt.Errorf("仅支持 .txt、.md、.docx 简历文件")
	}
}

func extractDOCXResumeText(fileContent []byte) (string, error) {
	docxReader, openErr := zip.NewReader(bytes.NewReader(fileContent), int64(len(fileContent)))
	if openErr != nil {
		return "", fmt.Errorf("DOCX 文件损坏或格式不正确: %w", openErr)
	}

	var documentFile *zip.File
	for _, zippedFile := range docxReader.File {
		if filepath.ToSlash(zippedFile.Name) == "word/document.xml" {
			documentFile = zippedFile
			break
		}
	}
	if documentFile == nil {
		return "", fmt.Errorf("DOCX 文件缺少正文内容")
	}
	documentReader, readErr := documentFile.Open()
	if readErr != nil {
		return "", fmt.Errorf("读取 DOCX 正文失败: %w", readErr)
	}
	decoder := xml.NewDecoder(documentReader)
	var resumeText strings.Builder
	insideText := false
	for {
		token, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			break
		}
		if tokenErr != nil {
			_ = documentReader.Close()
			return "", fmt.Errorf("解析 DOCX 正文失败: %w", tokenErr)
		}

		switch currentToken := token.(type) {
		case xml.StartElement:
			insideText = currentToken.Name.Local == "t"
			if currentToken.Name.Local == "tab" {
				resumeText.WriteByte('\t')
			}
			if currentToken.Name.Local == "br" || currentToken.Name.Local == "cr" {
				resumeText.WriteByte('\n')
			}
		case xml.EndElement:
			if currentToken.Name.Local == "t" {
				insideText = false
			}
			if currentToken.Name.Local == "p" {
				resumeText.WriteByte('\n')
			}
		case xml.CharData:
			if insideText {
				resumeText.Write([]byte(currentToken))
			}
		}
	}
	if closeErr := documentReader.Close(); closeErr != nil {
		return "", fmt.Errorf("关闭 DOCX 正文失败: %w", closeErr)
	}

	return normalizeExtractedResumeText(resumeText.String())
}

func normalizeExtractedResumeText(resumeText string) (string, error) {
	normalizedText := strings.TrimSpace(strings.ReplaceAll(resumeText, "\r\n", "\n"))
	if normalizedText == "" {
		return "", fmt.Errorf("简历文件没有可读取的文字内容")
	}
	return normalizedText, nil
}

func sanitizeImportedProfile(profile domain.CandidateProfile) domain.CandidateProfile {
	return domain.CandidateProfile{
		Name:            utils.CleanText(profile.Name, 30),
		TargetRole:      utils.CleanText(profile.TargetRole, 60),
		Email:           utils.CleanText(profile.Email, 120),
		Phone:           utils.CleanText(profile.Phone, 30),
		Location:        utils.CleanText(profile.Location, 40),
		Education:       utils.CleanText(profile.Education, 120),
		YearsExperience: utils.CleanText(profile.YearsExperience, 40),
		Skills:          limitImportedProfileSkills(profile.Skills),
	}
}

func limitImportedProfileSkills(skills []string) []string {
	limitedSkills := make([]string, 0, len(skills))
	for _, skill := range skills {
		cleanedSkill := utils.CleanText(skill, 30)
		if cleanedSkill == "" {
			continue
		}
		limitedSkills = append(limitedSkills, cleanedSkill)
		if len(limitedSkills) >= 20 {
			break
		}
	}
	return utils.UniqueNonEmpty(limitedSkills)
}
