const { UserModel, RegistrationCodeModel, TokenModel} = require('../models/models');
const bcrypt = require('bcrypt');
const uuid = require('uuid');
const MailService = require('./MailService');
const TokenService = require('./TokenService');
const UserDto = require('../dtos/UserDto');
const RegCodeDto = require('../dtos/RegCodeDto');
const ApiError = require('../exceptions/ApiError');
const generateCode = require('../utils/generateCode');

class UserService {

    async signUp(email, password) {
        const candidate = await UserModel.findOne({
            where: { email }
        });

        if (candidate) {
            throw ApiError.BadRequest(`Ошибка регистрации`,
                [
                    {
                        value: email,
                        msg: 'Пользователь с таким email уже существует',
                        param: 'email'
                    }
                ]
            );
        }

        const codeData = await RegistrationCodeModel.findOne({
            where: { email }
        });

        if (!codeData || !codeData.isConfirmed) {
            throw ApiError.BadRequest('Ошибка регистрации',
                [
                    {
                        value: email,
                        msg: 'Учетная запись не подтверждена',
                        param: 'email'
                    }
                ]
            );
        }

        const hashPassword = await bcrypt.hash(password, 7);
        const activationLink = uuid.v4();
        const user = await UserModel.create({ email, password: hashPassword, activationLink, isActivated: true });
        await RegistrationCodeModel.destroy({ where: { email } });
        const userDto = UserDto.fromModel(user);
        const tokens = TokenService.generateTokens({ ...userDto });
        await TokenService.saveRefreshToken(userDto.id, tokens.refreshToken);

        // await MailService.sendActivationMail(email, `${process.env.API_URL}/api/user/activate/${activationLink}`);

        return { ...tokens, user: userDto }
    }

    async activate(activationLink) {
        const  user = await UserModel.findOne({ where: { activationLink } });

        if (!user) {
            throw ApiError.BadRequest('Некорректная ссылка активации')
        }

        user.update({ isActivated: true });
    }

    async signIn(email, password) {
        const user = await UserModel.findOne({ where: { email } });

        if (!user) {
            throw ApiError.BadRequest('Ошибка авторизации',
                [
                    {
                        value: email,
                        msg: 'Пользователь с таким email не зарегистрирован',
                        param: 'email'
                    }
                ]
            );
        }

        const isPassEquals = await bcrypt.compare(password, user.password);

        if (!isPassEquals) {
            throw ApiError.BadRequest('Ошибка авторизации',
                [
                    {
                        value: password,
                        msg: 'Пароль введен неверно',
                        param: 'password'
                    }
                ]
            );
        }

        const userDto = UserDto.fromModel(user);

        const tokens = TokenService.generateTokens({ ...userDto });
        await TokenService.saveRefreshToken(userDto.id, tokens.refreshToken);
        return { ...tokens, user: userDto }
    }

    async logout(refreshToken) {
        const token = await TokenService.removeRefreshToken(refreshToken);
        return token;
    }

    async refresh(refreshToken) {
        if (!refreshToken) {
            throw ApiError.UnauthorizedError();
        }

        const tokenFromDB = await TokenService.findRefreshToken(refreshToken);
        if (!tokenFromDB) {
            throw ApiError.UnauthorizedError();
        }

        await TokenService.removeRefreshToken(refreshToken);

        const userData = TokenService.validateRefreshToken(refreshToken);
        if (!userData) {
            throw ApiError.UnauthorizedError();
        }

        const user = await UserModel.findOne({ where: { id: userData.id } });
        const userDto = UserDto.fromModel(user);

        const tokens = TokenService.generateTokens({ ...userDto });
        await TokenService.saveRefreshToken(userDto.id, tokens.refreshToken);

        return { ...tokens, user: userDto }
    }

    async sendRegistrationCode(email) {
        const candidate = await UserModel.findOne({
            where: { email }
        });

        if (candidate) {
            throw ApiError.BadRequest(`Ошибка отправки кода`,
                [
                    {
                        value: email,
                        msg: 'Пользователь с таким email уже существует',
                        param: 'email'
                    }
                ]
            );
        }

        const candidateCode = await RegistrationCodeModel.findOne({
            where: { email }
        });

        const currentDate = new Date();

        if (candidateCode && candidateCode.expiresIn > currentDate) {
            const secondsLeft = candidateCode.expiresIn.getSeconds() - currentDate.getSeconds();

            throw ApiError.BadRequest('Ошибка отправки кода',
                [
                    {
                        value: email,
                        msg: `Повторите отправку кода через: ${secondsLeft}`,
                        param: 'email',
                        secondsLeft: secondsLeft
                    }
                ]
            );
        }

        const code = generateCode();

        const date = new Date();
        date.setMinutes(date.getMinutes() + 1);

        const codeData = await RegistrationCodeModel.upsert({ email, otp: code, expiresIn: date, isConfirmed: false });

        const codeDto = RegCodeDto.fromArray(codeData);

        await MailService.sendRegistrationCode(email, code);
        return { codeDto }
    }

    async verifyRegistrationCode(email, code) {
        const codeData = await RegistrationCodeModel.findOne({
            where: { email, otp: code }
        });

        if (!codeData) {
            throw ApiError.BadRequest('Ошибка ввода кода',
                [
                    {
                        value: code,
                        msg: 'Код введен неверно!',
                        param: 'code',
                        isExpired: false
                    }
                ]
            );
        }

        if (codeData.expiresIn < new Date()) {
            throw ApiError.BadRequest('Ошибка ввода кода',
                [
                    {
                        value: code,
                        msg: 'Срок действия кода истек. Повторите запрос кода!',
                        param: 'code',
                        isExpired: true
                    }
                ]
            );
        }

        codeData.update({ isConfirmed: true });

        const codeDto = RegCodeDto.fromModel(codeData);
        return { codeDto }
    }

    async updateProfileData({ email, displayName, location, notifyAboutProductUpdates, notifyAboutMarketNewsletter, notifyAboutComments, notifyAboutPurchases }, userId) {
        const user = await UserModel.findByPk(userId);

        await user.update({ email, displayName, location, notifyAboutProductUpdates, notifyAboutMarketNewsletter, notifyAboutComments, notifyAboutPurchases })
        const userDto = UserDto.fromModel(user);

        return { user: userDto }
    }

    async updateProfilePassword({ oldPassword, newPassword, confirmNewPassword }, userId) {
        if (newPassword !== confirmNewPassword) {
            throw ApiError.BadRequest('Ошибка обновления пароля',
                [
                    {
                        value: confirmNewPassword,
                        msg: 'Пароли не совадают',
                        param: 'confirmNewPassword'
                    }
                ]
            );
        }

        const user = await UserModel.findByPk(userId);

        const isPassEquals = await bcrypt.compare(oldPassword, user.password);

        if (!isPassEquals) {
            throw ApiError.BadRequest('Ошибка обновления пароля',
                [
                    {
                        value: oldPassword,
                        msg: 'Старый пароль введен неверно',
                        param: 'oldPassword'
                    }
                ]
            );
        }

        const isNewPassEquals = await bcrypt.compare(newPassword, user.password);

        if (isNewPassEquals) {
            throw ApiError.BadRequest('Ошибка обновления пароля',
                [
                    {
                        value: newPassword,
                        msg: 'Новый пароль не должен совпадать со старым',
                        param: 'newPassword'
                    }
                ]
            );
        }

        const hashNewPassword = await bcrypt.hash(newPassword, 7);
        await user.update({ password: hashNewPassword });
        const userDto = UserDto.fromModel(user);

        return { user: userDto }
    }
}

module.exports = new UserService();