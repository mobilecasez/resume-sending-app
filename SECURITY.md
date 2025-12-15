# Security Features

## 🔒 Security Measures Implemented

### 1. **Authentication & Authorization**
- ✅ **JWT (JSON Web Tokens)**: Secure token-based authentication
- ✅ **Password Hashing**: BCrypt with 10 salt rounds
- ✅ **Token Expiration**: 24-hour token validity
- ✅ **Protected Routes**: All API endpoints require valid authentication
- ✅ **User Isolation**: Each user can only access their own data

### 2. **Database Security**
- ✅ **SQLite Database**: Local file-based database with restricted access
- ✅ **Parameterized Queries**: Protection against SQL injection attacks
- ✅ **Encrypted Credentials**: SMTP passwords encrypted with AES-256
- ✅ **User-specific Storage**: Each user's data is isolated in the database

### 3. **File Security**
- ✅ **User-specific Directories**: Files stored in `/uploads/user_{id}/` folders
- ✅ **Authenticated File Access**: Users can only access their own files
- ✅ **Filename Sanitization**: Special characters removed from filenames
- ✅ **File Size Limits**: 10MB maximum file size
- ✅ **File Type Validation**: Only allowed file types accepted

### 4. **Data Encryption**
- ✅ **SMTP Password Encryption**: AES-256 encryption for email credentials
- ✅ **Secure Key Storage**: Encryption keys stored in environment variables
- ✅ **Password Masking**: Passwords shown as `********` in frontend

### 5. **Session Management**
- ✅ **Express Sessions**: Secure session handling
- ✅ **Cookie Security**: HTTPOnly cookies (can be enhanced with HTTPS)
- ✅ **Session Expiration**: 24-hour session timeout

### 6. **API Security**
- ✅ **CORS Protection**: Cross-Origin Resource Sharing configured
- ✅ **Rate Limiting**: Can be implemented for production
- ✅ **Input Validation**: All user inputs validated server-side
- ✅ **Error Handling**: Secure error messages (no sensitive data leaked)

### 7. **Frontend Security**
- ✅ **Token Storage**: JWT stored in localStorage (isolated per domain)
- ✅ **Automatic Logout**: Expired tokens trigger automatic logout
- ✅ **Protected Routes**: Unauthenticated users redirected to login
- ✅ **XSS Prevention**: Input sanitization and validation

## 🛡️ Security Best Practices

### For Production Deployment:

1. **Environment Variables**
   - Generate strong random keys:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - Update `JWT_SECRET` and `ENCRYPTION_KEY` in `.env`
   - Never commit `.env` file to version control

2. **HTTPS/SSL**
   - Use HTTPS in production
   - Enable secure cookies: `cookie: { secure: true, httpOnly: true }`
   - Redirect HTTP to HTTPS

3. **Database**
   - Regular backups of `database.db`
   - Restrict file permissions: `chmod 600 database.db`
   - Consider moving to PostgreSQL/MySQL for production

4. **File Storage**
   - Set appropriate folder permissions: `chmod 700 uploads/`
   - Consider cloud storage (AWS S3, Google Cloud Storage)
   - Implement virus scanning for uploaded files

5. **Additional Security Measures**
   - Implement rate limiting (express-rate-limit)
   - Add CSRF protection (csurf)
   - Enable helmet.js for HTTP headers
   - Regular security audits and updates
   - Monitor logs for suspicious activity

6. **Backup Strategy**
   - Daily database backups
   - Backup encryption keys securely
   - Store backups in multiple locations

## 🚨 Security Checklist

Before deploying to production:

- [ ] Change all default keys in `.env`
- [ ] Enable HTTPS/SSL
- [ ] Set secure cookie flags
- [ ] Implement rate limiting
- [ ] Add CSRF protection
- [ ] Enable security headers (helmet.js)
- [ ] Set up database backups
- [ ] Configure firewall rules
- [ ] Set proper file permissions
- [ ] Review and test all endpoints
- [ ] Monitor application logs
- [ ] Set up intrusion detection

## 📞 Reporting Security Issues

If you discover a security vulnerability, please email: security@example.com

**Please do not open public issues for security vulnerabilities.**

## 🔄 Regular Security Updates

- Update dependencies monthly: `npm audit fix`
- Review security advisories: `npm audit`
- Keep Node.js updated to latest LTS version
- Monitor CVE databases for known vulnerabilities

---

**Last Updated**: December 4, 2025
