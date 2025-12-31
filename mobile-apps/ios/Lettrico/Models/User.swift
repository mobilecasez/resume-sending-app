//
//  User.swift
//  Lettrico
//
//  Data model for user information
//

import Foundation

struct User: Codable, Identifiable {
    let id: Int
    let fullName: String
    let email: String
    var phone: String?
    var dateOfBirth: String?
    var address: String?
    var resumePath: String?
    var photePath: String?
    var signaturePath: String?
    
    enum CodingKeys: String, CodingKey {
        case id
        case fullName = "fullName"
        case email
        case phone
        case dateOfBirth
        case address
        case resumePath
        case photePath
        case signaturePath
    }
}

struct AuthResponse: Codable {
    let success: Bool
    let token: String
    let user: User
}

struct CoverLetter: Codable, Identifiable {
    let id: UUID
    let companyName: String
    let position: String
    let content: String
    let generatedDate: Date
    let recipientEmail: String?
    
    enum CodingKeys: String, CodingKey {
        case id
        case companyName
        case position
        case content
        case generatedDate
        case recipientEmail
    }
}
