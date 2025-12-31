package com.lettrico.app.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: Int,
    val fullName: String,
    val email: String,
    val phone: String? = null,
    val dateOfBirth: String? = null,
    val address: String? = null,
    val resumePath: String? = null,
    val photePath: String? = null,
    val signaturePath: String? = null
)

@Serializable
data class AuthResponse(
    val success: Boolean,
    val token: String,
    val user: User
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String
)

@Serializable
data class RegisterRequest(
    val fullName: String,
    val email: String,
    val password: String
)

@Serializable
data class CoverLetter(
    val id: String,
    val companyName: String,
    val position: String,
    val content: String,
    val generatedDate: String,
    @SerialName("recipientEmail")
    val recipientEmail: String? = null
)

@Serializable
data class GenerateCoverLetterRequest(
    val userId: Int,
    val companyName: String,
    val position: String,
    val websiteUrl: String,
    val recipientEmail: String
)
